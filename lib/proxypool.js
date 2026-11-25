// Proxy pool for MailCheck — free SOCKS5 proxies, tested and rotated.
//
// Why this exists: a single free proxy IP gets flagged by big mail servers
// after a handful of SMTP probes (it looks like spam probing, because it is
// the same shape). The fix the real verification services use is a pool:
// test many proxies, keep the ones that answer on port 25, and rotate to
// the next one the moment one stops answering.
'use strict';

const https = require('https');
const net = require('net');
const { connectViaSocks5 } = require('./socks');

const LIST_BASE = 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=8000&ssl=all&anonymity=all&country=';
const TEST_HOST = 'gmail-smtp-in.l.google.com'; // a mail server that always answers when port 25 is truly open
const TEST_PORT = 25;
// Europe first: from Morocco these are the closest proxy locations, so
// they start with a latency advantage before any test is run. The global
// list is only a fallback for when Europe is nearly empty.
const EUROPE_COUNTRIES = ['ES', 'PT', 'FR', 'IT', 'NL', 'DE', 'BE', 'GB', 'IE', 'CH', 'AT', 'PL'];

// Fetch one country's free SOCKS5 list (one "host:port" per line).
function fetchList(country) {
  return new Promise((resolve, reject) => {
    https.get(LIST_BASE + country, (res) => {
      if (res.statusCode !== 200) return reject(new Error('proxy list server answered ' + res.statusCode));
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        const proxies = body.split('\n').map((s) => s.trim()).filter(Boolean).map((line) => {
          const [host, portStr] = line.split(':');
          return { host, port: parseInt(portStr, 10), username: '', password: '' };
        }).filter((p) => p.host && p.port);
        resolve(proxies);
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Fetch the free SOCKS5 list, European proxies first, deduped; the global
// list is appended only when Europe yields too little to hunt through.
async function fetchFreeProxies() {
  const lists = await Promise.all(EUROPE_COUNTRIES.map((c) => fetchList(c).catch(() => [])));
  const seen = new Set();
  const out = [];
  const add = (list) => {
    for (const p of list) {
      const key = p.host + ':' + p.port;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  };
  for (const list of lists) add(list);
  if (out.length < 30) add(await fetchList('all').catch(() => []));
  return out;
}

// Does this proxy pass port 25 — and how FAST? Connect through it to the
// target mail server and wait for the "220" greeting, timing the whole
// thing. A proxy that answers in 6 seconds passes a yes/no test but makes
// every email crawl (each check is ~6 round trips), so the pool ranks by
// speed and keeps the fastest. Returns { ok, ms }.
async function testProxy(proxy, timeoutMs = 7000, target = {}) {
  const targetHost = target.host || TEST_HOST;
  const targetPort = target.port || TEST_PORT;
  const started = Date.now();
  let sock = null;
  try {
    sock = await connectViaSocks5(proxy, targetHost, targetPort, timeoutMs);
    const banner = await new Promise((resolve) => {
      let data = '';
      // The banner gets only the time the overall test budget has left —
      // a proxy that connected but stays silent must not stretch the test
      // past its budget (it would fail the speed gate anyway).
      const remaining = Math.max(500, timeoutMs - (Date.now() - started));
      const t = setTimeout(() => resolve(data || null), remaining);
      sock.on('data', (c) => { data += c.toString(); if (data.includes('\n')) { clearTimeout(t); resolve(data); } });
      sock.on('error', () => { clearTimeout(t); resolve(null); });
      sock.on('close', () => { clearTimeout(t); resolve(data || null); });
    });
    return { ok: !!(banner && banner.startsWith('220')), ms: Date.now() - started };
  } catch (_) {
    return { ok: false, ms: Date.now() - started };
  } finally {
    if (sock) { try { sock.destroy(); } catch (_) {} }
  }
}

/**
 * Hunt for working proxies: fetch the free list, test candidates in
 * batches, stop as soon as `want` working ones are found.
 * @param {Object} cfg { scan = 60, want = 5, batchSize = 10, exclude, onProgress }
 *   exclude: Set of "host:port" already tried this run — skipped, so a
 *   refill hunt digs deeper into the list instead of retesting the dead.
 * @returns {Promise<Array>} working proxy objects (may be fewer than want, or empty)
 */
// Cheap first filter: is anything even listening on this proxy's port?
// Most free proxies on the list are simply OFFLINE — they used to cost the
// full test timeout each before failing. A bare TCP connect kills them in
// about a second (most refuse instantly); only survivors earn the real
// SOCKS5 + SMTP test.
function quickAlive(proxy, timeoutMs = 1200) {
  return new Promise((resolve) => {
    let settled = false;
    const sock = net.connect(proxy.port, proxy.host);
    const done = (v) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (_) {}
      resolve(v);
    };
    const t = setTimeout(() => done(false), timeoutMs);
    sock.once('connect', () => { clearTimeout(t); done(true); });
    sock.once('error', () => { clearTimeout(t); done(false); });
  });
}

async function findWorkingProxies({ scan = 60, want = 5, batchSize = 25, exclude, onProgress, maxMs = 2500, oversample = 2 } = {}) {
  const all = await fetchFreeProxies();
  const fresh = exclude ? all.filter((p) => !exclude.has(p.host + ':' + p.port)) : all;
  const candidates = fresh.slice(0, scan);
  const working = [];
  let fastestSlow = null; // best proxy that works but failed the speed gate
  // Oversample: test until we hold `oversample` times the wanted number,
  // then keep the FASTEST `want` — first-come-first-served fills the pool with whatever
  // far-away proxies happened to answer, and every check pays their lag.
  // SPEED GATE: a proxy must answer within maxMs or it is rejected even
  // though it works — the pool physically cannot contain a slow proxy.
  for (let i = 0; i < candidates.length && working.length < want * oversample; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    // Stage 1: cheap alive-filter. Stage 2: the full test, capped just
    // above the speed gate — anything slower is rejected by the gate
    // anyway, so waiting longer for it is pure waste.
    const aliveFlags = await Promise.all(batch.map((p) => quickAlive(p)));
    const survivors = batch.filter((_, idx) => aliveFlags[idx]);
    const results = await Promise.all(survivors.map(async (p) => {
      const r = await testProxy(p, maxMs + 700);
      return { p, ok: r.ok, ms: r.ms };
    }));
    for (const r of results) {
      if (!r.ok) continue;
      r.p.ms = r.ms;
      if (r.ms <= maxMs) working.push(r.p);
      else if (!fastestSlow || r.ms < fastestSlow.ms) fastestSlow = r.p;
    }
    if (onProgress) onProgress({ tested: Math.min(i + batchSize, candidates.length), total: candidates.length, found: working.length });
  }
  working.sort((a, b) => (a.ms || 0) - (b.ms || 0));
  const picked = working.slice(0, want);
  // A slow pool beats no pool: if the gate rejected everything, fall back
  // to the single fastest working proxy rather than going direct.
  if (!picked.length && fastestSlow) picked.push(fastestSlow);
  return picked;
}

/**
 * A rotator over a pool of proxies. The verifier asks for a proxy with
 * ensure() and reports each probe outcome; a proxy is retired on its FIRST
 * failure — one timeout and the run moves to the next proxy.
 *
 * THE HUNTER NEVER SLEEPS: a background top-up keeps the pool full WHILE
 * checks are running. Every proxy death that drops the pool to the
 * low-water mark wakes the hunter; it fetches fresh proxies (skipping
 * ones already tried this run) and adds them without stopping any check.
 * If a hunt finds nothing new, the dead pool is REVIVED — flags are
 * temporary, a proxy that timed out earlier may answer again. ensure()
 * only ever waits when the pool is completely empty. Hunts are
 * single-flight (concurrent workers share one) and capped by maxRefills
 * so a truly dead network still ends the run eventually.
 */
function createRotator(proxies, { hunt = null, onRefill = null, maxRefills = 30, targetPool = 8, lowWater = 3, onEvent = null } = {}) {
  const huntFn = hunt || onRefill;
  const pool = [];
  const seen = new Set();
  let topUpPromise = null;
  let huntsUsed = 0;
  let stopped = false;

  function emit(message) {
    if (onEvent) { try { onEvent(message); } catch (_) {} }
  }

  function addProxies(list) {
    let added = 0;
    for (const proxy of list || []) {
      const key = proxy.host + ':' + proxy.port;
      if (seen.has(key)) continue;
      seen.add(key);
      pool.push({ proxy, fails: 0, dead: false });
      added++;
    }
    return added;
  }
  addProxies(proxies);

  function topUp() {
    if (stopped || !huntFn) return Promise.resolve();
    if (topUpPromise) return topUpPromise;
    if (rotator.aliveCount() >= targetPool) return Promise.resolve();
    topUpPromise = (async () => {
      let revived = false;
      try {
        while (!stopped && rotator.aliveCount() < targetPool && huntsUsed < maxRefills) {
          huntsUsed++;
          const fresh = await huntFn(new Set(seen));
          if (fresh && fresh.length) {
            const added = addProxies(fresh);
            if (added) emit('Hunter: +' + added + ' fresh ' + (added === 1 ? 'proxy' : 'proxies') + ' — pool now ' + rotator.aliveCount() + ' alive.');
            else if (!revived && pool.some((e) => e.dead)) {
              for (const e of pool) { e.fails = 0; e.dead = false; }
              revived = true;
              emit('Hunter: no fresh proxies — revived the earlier pool (' + rotator.aliveCount() + ' alive).');
            } else break;
          } else if (!revived && pool.some((e) => e.dead)) {
            for (const e of pool) { e.fails = 0; e.dead = false; }
            revived = true;
            emit('Hunter: no fresh proxies — revived the earlier pool (' + rotator.aliveCount() + ' alive).');
          } else break;
        }
      } catch (_) { /* a failed hunt is not fatal — the next death retries */ }
      finally { topUpPromise = null; }
    })();
    return topUpPromise;
  }

  let rrIndex = 0;
  const rotator = {
    current() {
      // Round-robin across the alive pool: spreading workers over every
      // proxy beats hammering proxy #1 with all of them at once (which is
      // both slower and gets that one IP flagged almost immediately).
      for (let n = 0; n < pool.length; n++) {
        const i = (rrIndex + n) % pool.length;
        if (!pool[i].dead) {
          rrIndex = i + 1;
          return pool[i].proxy;
        }
      }
      return null;
    },
    async ensure() {
      const cur = rotator.current();
      if (cur) {
        if (rotator.aliveCount() <= lowWater) void topUp();
        return cur;
      }
      await topUp();
      return rotator.current();
    },
    start() { void topUp(); },
    stop() { stopped = true; },
    reportOk(proxy) {
      const entry = pool.find((e) => e.proxy === proxy);
      if (entry) entry.fails = 0;
    },
    reportFail(proxy) {
      const entry = pool.find((e) => e.proxy === proxy);
      if (entry) {
        entry.fails++;
        if (entry.fails >= 1) entry.dead = true;
      }
      if (!stopped && rotator.aliveCount() <= lowWater) void topUp();
    },
    aliveCount() {
      return pool.filter((e) => !e.dead).length;
    },
    size() {
      return pool.length;
    },
    refillsUsed() {
      return huntsUsed;
    },
  };
  return rotator;
}

module.exports = { fetchFreeProxies, testProxy, findWorkingProxies, createRotator };
