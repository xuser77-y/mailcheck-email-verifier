#!/usr/bin/env node
/**
 * find-working-proxy.js — MailCheck helper.
 *
 * Free SOCKS5 proxies die fast and most of them block port 25 (the port
 * MailCheck knocks on). This script does the boring trial-and-error for you:
 * it grabs a fresh free SOCKS5 list, tries each proxy against Gmail's mail
 * server on port 25, and prints the ones that actually answer.
 *
 * Usage:  node find-working-proxy.js [count]
 *   count = how many proxies to try (default 30)
 *
 * Then paste a working host + port into MailCheck's proxy settings.
 * Needs no dependencies — uses the SOCKS5 client from lib/socks.js.
 */
'use strict';

const https = require('https');
const { connectViaSocks5 } = require('./lib/socks');

const TEST_HOST = 'gmail-smtp-in.l.google.com';
const TEST_PORT = 25;
const PROXY_TIMEOUT = 7000;
const BANNER_TIMEOUT = 5000;

const count = Math.max(1, Math.min(100, parseInt(process.argv[2], 10) || 30));

function fetchProxyList() {
  const url = 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=8000&country=all&ssl=all&anonymity=all';
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error('list server answered ' + res.statusCode));
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body.split('\n').map(s => s.trim()).filter(Boolean)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function testProxy(line) {
  const [host, portStr] = line.split(':');
  const proxy = { host, port: parseInt(portStr, 10), username: '', password: '' };
  if (!proxy.port) return { line, ok: false, why: 'bad line' };
  try {
    const sock = await connectViaSocks5(proxy, TEST_HOST, TEST_PORT, PROXY_TIMEOUT);
    const banner = await new Promise((resolve) => {
      let data = '';
      const t = setTimeout(() => resolve(data || null), BANNER_TIMEOUT);
      sock.on('data', (c) => { data += c.toString(); if (data.includes('\n')) { clearTimeout(t); resolve(data); } });
      sock.on('error', () => { clearTimeout(t); resolve(null); });
      sock.on('close', () => { clearTimeout(t); resolve(data || null); });
    });
    sock.destroy();
    if (banner && banner.startsWith('220')) return { line, ok: true, banner: banner.trim().slice(0, 60) };
    return { line, ok: false, why: banner ? 'answered but no 220 banner' : 'connected, no banner' };
  } catch (e) {
    return { line, ok: false, why: String(e.message || e).slice(0, 60) };
  }
}

(async () => {
  let lines;
  if (process.argv.includes('--file')) {
    const fs = require('fs');
    const f = process.argv[process.argv.indexOf('--file') + 1];
    console.log(`Reading proxies from ${f}, testing against ${TEST_HOST}:${TEST_PORT}...\n`);
    lines = fs.readFileSync(f, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  } else {
    console.log(`Fetching a fresh free SOCKS5 list, testing the first ${count} against ${TEST_HOST}:${TEST_PORT}...\n`);
    try {
      lines = await fetchProxyList();
    } catch (e) {
      console.error('Could not fetch the proxy list:', e.message);
      console.error('Check your internet, or paste proxies into proxies.txt (one host:port per line) and run: node find-working-proxy.js --file proxies.txt');
      process.exit(1);
    }
  }
  const batch = lines.slice(0, count);
  const results = await Promise.all(batch.map(testProxy));
  const working = results.filter(r => r.ok);
  console.log('---');
  for (const r of results) {
    console.log(`${r.ok ? 'WORKS ' : 'fail  '} ${r.line}  ${r.ok ? '— ' + r.banner : '— ' + r.why}`);
  }
  console.log('---');
  if (working.length) {
    console.log(`\n${working.length} proxy(ies) pass port 25. Paste one into MailCheck's proxy settings:`);
    for (const w of working) console.log(`  host: ${w.line.split(':')[0]}   port: ${w.line.split(':')[1]}`);
    console.log('\nThen run ONE email first (your own Gmail) to confirm before the full list.');
  } else {
    console.log('\nNone of these pass port 25. Free proxies are like that — most block mail traffic.');
    console.log('Run it again in a few hours for a fresh list, or try a different source (spys.one, free-proxy-list.net).');
  }
})().catch((e) => { console.error('Unexpected error:', e.message); process.exit(1); });
