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
  // The global list always goes on the tail: if the European slice turns
  // out to be dead weight, later hunts still reach the rest of the world.
  add(await fetchList('all').catch(() => []));
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

async function findWorkingProxies({ scan = Infinity, want = 5, batchSize = 25, exclude, onProgress, maxMs = 2500, oversample = 2 } = {}) {
  const all = await fetchFreeProxies();
  const fresh = exclude ? all.filter((p) => !exclude.has(p.host + ':' + p.port)) : all;
  const candidates = fresh.slice(0, scan);
  const working = [];
  let testedCount = 0;
  // Speed decides ORDER, never availability: the hunt stops as soon as it
  // holds enough WORKING proxies (fast or slow), then sorts fastest-first.
  // An earlier version stopped only on under-2.5s proxies — from Morocco
  // those are rare, so the hunt scanned forever while checks waited.
  for (let i = 0; i < candidates.length && working.length < want * oversample; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    // Mark every candidate we touch in the caller's tried-set, so the
    // next hunt in this run moves PAST them instead of re-testing the
    // same dead head of the list forever.
    if (exclude) for (const p of batch) exclude.add(p.host + ':' + p.port);
    testedCount += batch.length;
    // Stage 1: cheap alive-filter. Stage 2: the full test with a generous
    // budget, so slow-but-working proxies still register as working.
    const aliveFlags = await Promise.all(batch.map((p) => quickAlive(p)));
    const survivors = batch.filter((_, idx) => aliveFlags[idx]);
    const results = await Promise.all(survivors.map(async (p) => {
      const r = await testProxy(p, 9000);
      return { p, ok: r.ok, ms: r.ms };
    }));
    for (const r of results) {
      if (!r.ok) continue;
      r.p.ms = r.ms;
      working.push(r.p);
    }
    if (onProgress) onProgress({ tested: Math.min(i + batchSize, candidates.length), total: candidates.length, found: working.length });
  }
  working.sort((a, b) => (a.ms || 0) - (b.ms || 0));
  const picked = working.slice(0, want);
  // Metadata for the rotator: how many untried candidates existed and how
  // many were tested — freshCount 0 means the run has tried the whole
  // list, which is the rotator's cue to recycle it.
  picked.freshCount = fresh.length;
  picked.testedCount = testedCount;
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
function createRotator(proxies, { hunt = null, onRefill = null, maxRefills = 1000, targetPool = 8, lowWater = 3, onEvent = null } = {}) {
  const huntFn = hunt || onRefill;
  const pool = [];
  const inPool = new Set(); // keys currently in the pool — never cleared
  const tried = new Set(); // keys hunts have already tested this run — cleared when the list is recycled
  let topUpPromise = null;
  let huntsUsed = 0;
  let stopped = false;

  function emit(message) {
    if (onEvent) { try { onEvent(message); } catch (_) {} }
  }

  const waiters = []; // ensure() calls parked until a proxy lands
  function wakeWaiters() {
    const parked = waiters.splice(0);
    for (const wake of parked) wake();
  }

  function addProxies(list) {
    let added = 0;
    for (const proxy of list || []) {
      const key = proxy.host + ':' + proxy.port;
      if (inPool.has(key)) continue;
      inPool.add(key);
      tried.add(key);
      pool.push({ proxy, fails: 0, dead: false });
      added++;
    }
    // The moment a proxy lands, parked checkers resume — they must never
    // sit out the rest of the hunt just because the pool isn't full yet.
    if (added) wakeWaiters();
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
          const fresh = await huntFn(tried);
          const added = fresh && fresh.length ? addProxies(fresh) : 0;
          if (added) {
            emit('Hunter: +' + added + ' fresh ' + (added === 1 ? 'proxy' : 'proxies') + ' — pool now ' + rotator.aliveCount() + ' alive.');
            continue;
          }
          if (!revived && pool.some((e) => e.dead)) {
            for (const e of pool) { e.fails = 0; e.dead = false; }
            revived = true;
            emit('Hunter: no fresh proxies — revived the earlier pool (' + rotator.aliveCount() + ' alive).');
            continue;
          }
          // The hunt found nothing untried left to test: the whole list
          // has been tried. NEVER STOP — wipe the tried-memory and hunt
          // the list again from the top. Free proxies flicker: one that
          // was dead an hour ago may answer now.
          if (fresh && fresh.freshCount === 0 && tried.size) {
            tried.clear();
            emit('Hunter: whole list tried — starting over, proxies come back to life.');
            continue;
          }
          break;
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
      for (;;) {
        const cur = rotator.current();
        if (cur) {
          if (rotator.aliveCount() <= lowWater) void topUp();
          return cur;
        }
        if (stopped || !huntFn || huntsUsed >= maxRefills) return null;
        // Park until the FIRST proxy lands (addProxies wakes us) or the
        // current hunt finishes — never for the whole pool to fill.
        const landed = new Promise((resolve) => waiters.push(resolve));
        await Promise.race([landed, topUp()]);
      }
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
