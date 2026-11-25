// Email verification core — no external dependencies.
// Pipeline per address:
//   1. syntax  ->  2. disposable / role flags  ->  3. MX lookup
//   4. catch-all probe (once per domain, cached)  ->  5. SMTP RCPT TO probe
// The SMTP probe never sends an email: it disconnects before DATA.
const dns = require('dns').promises;
const net = require('net');
const { connectViaSocks5 } = require('./socks');
const { DISPOSABLE_DOMAINS, ROLE_LOCAL_PARTS, FREE_PROVIDERS } = require('./disposable');

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function randomToken(n = 10) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < n; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// --- SMTP session helper -------------------------------------------------
// Reads SMTP replies (multi-line: "250-..." continues, "250 ..." ends).
class SmtpSession {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.buf = Buffer.alloc(0);
    this.lines = [];
    this.waiters = [];
    this.ended = false;
    socket.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      let idx;
      while ((idx = this.buf.indexOf(0x0a)) !== -1) {
        const raw = this.buf.slice(0, idx).toString('utf8').replace(/\r$/, '');
        this.buf = this.buf.slice(idx + 1);
        // Some sandboxes / networks intercept outbound SMTP and answer with
        // a policy message instead of an SMTP greeting. Say so plainly
        // instead of failing with a cryptic "socket closed".
        if (raw.startsWith('muse:')) {
          this.failAll(new Error('Outbound SMTP is blocked on this machine. Run MailCheck on your own computer or a VPS to do live mailbox probes.'));
          return;
        }
        this.lines.push(raw);
        this.drain();
      }
    });
    socket.on('error', () => this.failAll(new Error('socket error')));
    socket.on('close', () => this.failAll(new Error('socket closed')));
  }

  drain() {
    while (this.waiters.length) {
      const w = this.waiters[0];
      // A reply is complete when the last line starts with "NNN " (space).
      const last = this.lines[this.lines.length - 1];
      if (!last || !/^\d{3} /.test(last)) return;
      this.waiters.shift();
      const lines = this.lines.splice(0);
      clearTimeout(w.timer);
      const code = parseInt(lines[0].slice(0, 3), 10);
      w.resolve({ code, text: lines.join(' | ') });
    }
  }

  failAll(err) {
    if (this.ended) return;
    this.ended = true;
    while (this.waiters.length) {
      const w = this.waiters.shift();
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  readReply(label = 'server') {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.resolve === resolve);
        if (i !== -1) this.waiters.splice(i, 1);
        reject(new Error('SMTP timed out waiting for ' + label + ' reply'));
      }, this.timeoutMs);
      this.waiters.push({ resolve, reject, timer });
      this.drain();
    });
  }

  async send(line) {
    await new Promise((resolve, reject) => {
      this.socket.write(line + '\r\n', (err) => (err ? reject(err) : resolve()));
    });
    return this.readReply((line.split(/\s+/, 1)[0] || 'SMTP command').toUpperCase());
  }

  close() {
    // Finish the TCP stream cleanly. Writing QUIT and immediately destroying
    // the socket can reset the connection before the peer reads that command.
    try { this.socket.end('QUIT\r\n'); } catch (_) { try { this.socket.destroy(); } catch (_) {} }
  }
}

async function openSocket(host, port, options) {
  const { proxy, timeoutMs } = options;
  if (proxy && proxy.host) {
    return connectViaSocks5(proxy, host, port, timeoutMs);
  }
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      try { socket.destroy(); } catch (_) {}
      reject(new Error('connect timed out'));
    }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

// One RCPT TO probe against one MX host. Returns { code, text } or throws.
async function rcptProbe(mxHost, target, options) {
  const socket = await openSocket(mxHost, options.smtpPort || 25, options);
  if (typeof options.onStage === 'function') options.onStage(target, 'mailbox', 'Connected; checking mailbox response');
  const session = new SmtpSession(socket, options.timeoutMs);
  try {
    const greet = await session.readReply('greeting');
    if (greet.code !== 220) throw new Error('bad greeting: ' + greet.code);
    const ehlo = await session.send('EHLO ' + options.helo);
    if (ehlo.code !== 250) throw new Error('EHLO rejected: ' + ehlo.code);
    const mailFrom = await session.send('MAIL FROM:<' + options.mailFrom + '>');
    if (mailFrom.code !== 250) throw new Error('MAIL FROM rejected: ' + mailFrom.code);
    const rcpt = await session.send('RCPT TO:<' + target + '>');
    return rcpt;
  } catch (e) {
    if (/SMTP timed out waiting/.test(e.message || '')) {
      throw new Error(e.message + ' from ' + mxHost + ':' + (options.smtpPort || 25));
    }
    throw e;
  } finally {
    session.close();
  }
}

// --- MX lookup -------------------------------------------------------------
// System DNS first; DNS-over-HTTPS (Google, then Cloudflare) as fallback for
// networks where the local resolver refuses MX queries.

async function mxViaDoh(domain, provider) {
  const url = provider === 'cloudflare'
    ? 'https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(domain) + '&type=MX'
    : 'https://dns.google/resolve?name=' + encodeURIComponent(domain) + '&type=MX';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/dns-json' }, signal: ctrl.signal });
    if (!res.ok) throw new Error('DoH HTTP ' + res.status);
    const json = await res.json();
    if (json.Status === 3) return { records: [], answered: true }; // NXDOMAIN
    if (json.Status !== 0) throw new Error('DoH DNS status ' + json.Status);
    const answers = json.Answer || [];
    const records = answers
      .filter((a) => a.type === 15)
      .map((a) => {
        const [priority, exchange] = a.data.trim().split(/\s+/);
        return { priority: parseInt(priority, 10) || 0, exchange: (exchange || '').replace(/\.$/, '') };
      })
      .filter((m) => m.exchange)
      .sort((a, b) => a.priority - b.priority)
      .map((m) => m.exchange);
    return { records, answered: true };
  } finally {
    clearTimeout(timer);
  }
}

// Does the domain exist at all? Asked over DoH, whose NXDOMAIN answer is
// trustworthy even on networks whose local resolver wildcard-answers every
// name (some ISPs and proxies do this, which would fake an A record).
// Returns true / false, or null when DoH itself could not be reached.
async function domainExistsViaDoh(domain) {
  for (const provider of ['google', 'cloudflare']) {
    const url = provider === 'cloudflare'
      ? 'https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(domain) + '&type=A'
      : 'https://dns.google/resolve?name=' + encodeURIComponent(domain) + '&type=A';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(url, { headers: { Accept: 'application/dns-json' }, signal: ctrl.signal });
      if (!res.ok) continue;
      const json = await res.json();
      if (json.Status === 3) return false; // NXDOMAIN — domain does not exist
      if (json.Status === 0) return true;
    } catch (_) { /* try next provider */ } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// Returns { records: string[] | null, answered: boolean }.
// "answered" means some DNS source actually responded — only then may a
// missing MX be treated as fact. If every lookup failed (dead resolver,
// blocked network, no fetch), answered is false and the caller must say
// "unknown", never "invalid": the tool could not check, the domain is not
// proven mail-less. (A gmail.com can never be "no MX" — if a run claims
// that, the lookup failed on that machine.)
async function lookupMx(domain) {
  try {
    const mxs = await dns.resolveMx(domain);
    if (mxs && mxs.length) {
      const records = mxs.sort((a, b) => a.priority - b.priority).map((m) => m.exchange).filter((host) => host && host !== '.');
      if (records.length) return { records, answered: true };
      return { records: null, answered: true }; // RFC 7505 null MX
    }
    return { records: null, answered: true }; // resolver answered: no MX records
  } catch (e) {
    // ENOTFOUND/ENODATA can be caused by a local resolver or network policy.
    // Ask independent resolvers below before treating it as a real absence.
    // EREFUSED / ETIMEOUT / ESERVFAIL etc. — the resolver itself failed.
  }
  for (const provider of ['google', 'cloudflare']) {
    try {
      const result = await mxViaDoh(domain, provider);
      if (result.records.length) return result;
      // A domain with no MX can still accept mail at its A/AAAA address.
      const exists = await domainExistsViaDoh(domain);
      return { records: null, answered: exists === false || exists === true };
    } catch (_) { /* try next provider */ }
  }
  return { records: null, answered: false };
}

// --- Public API ----------------------------------------------------------

const DEFAULT_OPTIONS = {
  timeoutMs: 12000,          // per SMTP reply / connect
  helo: 'mailcheck.local',   // hostname announced in EHLO
  mailFrom: 'verify@mailcheck.local', // MAIL FROM address (never receives mail)
  proxy: null,               // { host, port, username, password } or null
  catchAllProbe: true,
};

/**
 * Verify one address.
 * @param {string} email
 * @param {Object} options (see DEFAULT_OPTIONS)
 * @param {Map} domainCache shared per run: domain -> { mx, catchAll }
 * @returns {Promise<Object>} { email, status, reason, domain, mx, flags, ms }
 *   status: valid | invalid | risky | unknown | disposable
 */
async function verifyEmail(email, options = {}, domainCache = new Map()) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const started = Date.now();
  const finish = (status, reason, extra = {}) => ({
    email,
    status,
    reason,
    domain: email.includes('@') ? email.split('@')[1].toLowerCase() : '',
    flags: [],
    ms: Date.now() - started,
    ...extra,
  });
  const stage = (name, detail) => {
    if (typeof opts.onStage === 'function') {
      try { opts.onStage(email, name, detail); } catch (_) { /* progress UI must not stop verification */ }
    }
  };
  const raw = String(email || '').trim();
  const probeOptions = {
    ...opts,
    onStage: (address, name, detail) => {
      if (address === raw) stage(name, detail);
    },
  };

  stage('syntax', 'Checking address format');
  if (!raw || raw.length > 254 || !EMAIL_RE.test(raw)) {
    return finish('invalid', 'Bad syntax');
  }
  const [local, domain] = raw.split('@');
  const domainLower = domain.toLowerCase();
  const flags = [];
  if (ROLE_LOCAL_PARTS.has(local.toLowerCase())) flags.push('role');
  if (FREE_PROVIDERS.has(domainLower)) flags.push('free-provider');

  if (DISPOSABLE_DOMAINS.has(domainLower)) {
    stage('complete', 'Disposable address');
    return finish('disposable', 'Disposable / temporary email provider', { flags });
  }

  // MX lookup (cached per run).
  stage('dns', 'Looking up the domain mail server');
  let entry = domainCache.get(domainLower);
  if (!entry) {
    entry = { mx: null, catchAll: null };
    entry.mxPromise = lookupMx(domainLower).then((mxInfo) => {
      entry.mx = mxInfo.records;
      entry.mxAnswered = mxInfo.answered;
      return mxInfo;
    });
    domainCache.set(domainLower, entry);
  }
  if (entry.mxPromise) {
    const mxInfo = await entry.mxPromise;
    entry.mxPromise = null;
    if (!entry.mx && !mxInfo.answered) {
      return finish('unknown', 'Could not look up this domain\'s mail servers — every DNS lookup failed on this machine (network/DNS problem). Nothing was proven; check your connection or DNS and run it again.', { flags, mx: null });
    }
    if (!entry.mx) {
      // Some small domains accept mail on their A record. Only trust the A
      // record when the domain provably exists (see domainExistsViaDoh).
      const exists = await domainExistsViaDoh(domainLower);
      if (exists !== false) {
        const addresses = await Promise.allSettled([dns.resolve4(domainLower), dns.resolve6(domainLower)]);
        if (addresses.some((result) => result.status === 'fulfilled' && result.value.length)) {
          entry.mx = [domainLower]; // RFC fallback: deliver directly to the domain host
        }
      }
    }
  }
  if (!entry.mx) {
    stage('complete', 'No mail server found');
    return finish('invalid', 'Domain has no mail server (no MX record)', { flags, mx: null });
  }

  // Catch-all probe, once per domain per run.
  if (opts.catchAllProbe && entry.catchAll === null) {
    stage('catchall', 'Checking whether the domain accepts every address');
    const probeAddr = 'x' + randomToken(12) + '@' + domainLower;
    try {
      const res = await probeOnce(entry.mx, probeAddr, probeOptions);
      entry.catchAll = res.code === 250;
    } catch (_) {
      entry.catchAll = false; // inconclusive -> do not assume catch-all
    }
  }

  // Real probe (try up to 2 MX hosts; retry once on greylisting).
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const mxHost of entry.mx.slice(0, 2)) {
      try {
        stage('connect', 'Connecting to ' + mxHost + ':' + (opts.smtpPort || 25));
        const res = await probeOnce(entry.mx, raw, probeOptions, mxHost);
        if (res.code === 250) {
          if (entry.catchAll) {
            stage('complete', 'Domain is catch-all');
            return finish('risky', 'Domain accepts all addresses (catch-all) — cannot confirm this mailbox', { flags, mx: mxHost });
          }
          stage('complete', 'Mailbox accepted');
          return finish('valid', 'Mailbox confirmed by the mail server', { flags, mx: mxHost });
        }
        if (res.code === 550 || res.code === 551 || res.code === 553) {
          stage('complete', 'Mailbox rejected');
          return finish('invalid', 'Mailbox rejected by the mail server (' + res.code + ')', { flags, mx: mxHost });
        }
        if (res.code >= 400 && res.code < 500) {
          // Temporary failure (greylisting / throttling) — retry once.
          lastError = 'Temporary rejection (' + res.code + ')';
          await sleep(2000);
          continue;
        }
        stage('complete', 'Mail server returned an unexpected response');
        return finish('unknown', 'Unexpected mail server reply (' + res.code + ')', { flags, mx: mxHost });
      } catch (e) {
        lastError = e.message || 'connection failed';
        continue; // try next MX host
      }
    }
    if (attempt === 0) await sleep(1500);
  }
  const connectionTimedOut = /connect timed out|ETIMEDOUT/i.test(lastError || '');
  const smtpReplyTimedOut = /SMTP timed out waiting/.test(lastError || '');
  const reason = connectionTimedOut
    ? 'Connection to the mail server timed out on port 25. Your network or hosting provider may block outbound SMTP; this does not mean the address is invalid.'
    : smtpReplyTimedOut
      ? (lastError + '. The TCP connection opened, but the server did not answer the SMTP step. This can happen when the VPN exit or mail server filters SMTP. Try another VPN exit or a SOCKS5 proxy that allows SMTP; this does not mean the address is invalid.')
    : 'Could not reach the mail server: ' + (lastError || 'connection failed');
  stage('complete', connectionTimedOut ? 'SMTP port 25 did not respond' : smtpReplyTimedOut ? 'Mail server stopped answering SMTP' : 'Mail server could not be reached');
  return finish('unknown', reason, { flags, mx: entry.mx[0] });
}

// Probe one address against the MX list (first reachable host wins the reply).
// When mxHost is given, only that host is tried.
async function probeOnce(mxList, target, opts, mxHost) {
  const hosts = mxHost ? [mxHost] : mxList.slice(0, 2);
  let lastErr = null;
  for (const host of hosts) {
    try {
      return await rcptProbe(host, target, opts);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('no MX host reachable');
}

/**
 * Verify a list with a worker pool, streaming results as they finish.
 * @param {string[]} emails
 * @param {Object} options + { concurrency, onResult(result) }
 */
async function verifyList(emails, options = {}) {
  const { concurrency = 5, onResult, onStage, ...verifyOpts } = options;
  const cache = new Map();
  const results = new Array(emails.length);
  let next = 0;
  async function worker() {
    while (next < emails.length) {
      const i = next++;
      const result = await verifyEmail(emails[i], {
        ...verifyOpts,
        onStage: (email, stage, detail) => onStage && onStage(email, stage, detail, i),
      }, cache);
      results[i] = result;
      if (onResult) onResult(result, i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, emails.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

module.exports = { verifyEmail, verifyList, DEFAULT_OPTIONS, _test: { rcptProbe, probeOnce, lookupMx } };
