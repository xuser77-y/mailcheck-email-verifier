// Proxy pool for MailCheck — free SOCKS5 proxies, tested and rotated.
//
// Why this exists: a single free proxy IP gets flagged by big mail servers
// after a handful of SMTP probes (it looks like spam probing, because it is
// the same shape). The fix the real verification services use is a pool:
// test many proxies, keep the ones that answer on port 25, and rotate to
// the next one the moment one stops answering.
'use strict';

const https = require('https');
const { connectViaSocks5 } = require('./socks');

const LIST_URL = 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=8000&country=all&ssl=all&anonymity=all';
const TEST_HOST = 'gmail-smtp-in.l.google.com'; // a mail server that always answers when port 25 is truly open
const TEST_PORT = 25;

// Fetch the current free SOCKS5 list (one "host:port" per line).
function fetchFreeProxies() {
  return new Promise((resolve, reject) => {
    https.get(LIST_URL, (res) => {
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

// Does this proxy pass port 25? Connect through it to Gmail's mail server
// and wait for the "220" greeting. Anything else (refused, timeout, no
// banner) means this proxy is useless for mailbox probes.
async function testProxy(proxy, timeoutMs = 7000, target = {}) {
  const targetHost = target.host || TEST_HOST;
  const targetPort = target.port || TEST_PORT;
  let sock = null;
  try {
    sock = await connectViaSocks5(proxy, targetHost, targetPort, timeoutMs);
    const banner = await new Promise((resolve) => {
      let data = '';
      const t = setTimeout(() => resolve(data || null), 5000);
      sock.on('data', (c) => { data += c.toString(); if (data.includes('\n')) { clearTimeout(t); resolve(data); } });
      sock.on('error', () => { clearTimeout(t); resolve(null); });
      sock.on('close', () => { clearTimeout(t); resolve(data || null); });
    });
    return !!(banner && banner.startsWith('220'));
  } catch (_) {
    return false;
  } finally {
    if (sock) { try { sock.destroy(); } catch (_) {} }
  }
}

/**
 * Hunt for working proxies: fetch the free list, test candidates in
 * batches, stop as soon as `want` working ones are found.
 * @param {Object} cfg { scan = 60, want = 5, batchSize = 10, onProgress }
 * @returns {Promise<Array>} working proxy objects (may be fewer than want, or empty)
 */
async function findWorkingProxies({ scan = 60, want = 5, batchSize = 10, onProgress } = {}) {
  const candidates = (await fetchFreeProxies()).slice(0, scan);
  const working = [];
  for (let i = 0; i < candidates.length && working.length < want; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (p) => ({ p, ok: await testProxy(p) })));
    for (const r of results) if (r.ok) working.push(r.p);
    if (onProgress) onProgress({ tested: Math.min(i + batchSize, candidates.length), total: candidates.length, found: working.length });
  }
  return working.slice(0, want);
}

/**
 * A rotator over a pool of proxies. The verifier asks for current(), and
 * reports each probe outcome; a proxy is retired on its FIRST failure —
 * one timeout and the run moves to the next proxy, no second chances
 * and current() moves on to the next one.
 */
function createRotator(proxies) {
  const pool = (proxies || []).map((proxy) => ({ proxy, fails: 0, dead: false }));
  return {
    current() {
      const entry = pool.find((e) => !e.dead);
      return entry ? entry.proxy : null;
    },
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
    },
    aliveCount() {
      return pool.filter((e) => !e.dead).length;
    },
    size() {
      return pool.length;
    },
  };
}

module.exports = { fetchFreeProxies, testProxy, findWorkingProxies, createRotator };
