// MailCheck tests — run with: npm test
// Spins up a mock SMTP server and a mock SOCKS5 proxy on localhost and
// checks the whole verification pipeline without touching the internet.
'use strict';

const net = require('net');
const dns = require('dns');

// --- Mock DNS: point test domains at the local mock SMTP server ----------
const MOCK_SMTP_PORT = 2525;
const origResolveMx = dns.promises.resolveMx;
const origResolve4 = dns.promises.resolve4;
dns.promises.resolveMx = async (domain) => {
  if (domain === 'mock.test' || domain === 'catchall.test') {
    return [{ exchange: '127.0.0.1', preference: 10 }];
  }
  const e = new Error('queryMx ENOTFOUND ' + domain);
  e.code = 'ENOTFOUND';
  throw e;
};
dns.promises.resolve4 = async () => {
  const e = new Error('queryA ENOTFOUND');
  e.code = 'ENOTFOUND';
  throw e;
};

const { verifyEmail, verifyList } = require('../lib/verifier');

// --- Mock SMTP server ------------------------------------------------------
// Behaviour per RCPT address (domain mock.test):
//   valid@mock.test     -> 250 (mailbox exists)
//   invalid@mock.test   -> 550 (no such mailbox)
//   grey@mock.test      -> 450 first time, 250 after (greylisting retry)
//   slow@mock.test      -> never replies (timeout)
// Domain catchall.test: any address -> 250 (catch-all)
const greySeen = new Set();
function mockSmtpServer() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.write('220 mock.test Mock SMTP ready\r\n');
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\r\n')) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const [cmd, arg] = line.split(/\s+/, 2);
          const c = (cmd || '').toUpperCase();
          if (c === 'EHLO' || c === 'HELO') {
            socket.write('250-mock.test greets you\r\n250 8BITMIME\r\n');
          } else if (c === 'MAIL') {
            socket.write('250 OK\r\n');
          } else if (c === 'RCPT') {
            const m = /<([^>]+)>/.exec(arg || '');
            const addr = (m ? m[1] : '').toLowerCase();
            if (addr.endsWith('@catchall.test')) {
              socket.write('250 OK\r\n');
            } else if (addr === 'valid@mock.test') {
              socket.write('250 OK\r\n');
            } else if (addr === 'info@mock.test') {
              socket.write('250 OK\r\n'); // role address, real mailbox
            } else if (addr === 'invalid@mock.test') {
              socket.write('550 No such mailbox\r\n');
            } else if (addr === 'grey@mock.test') {
              if (greySeen.has(addr)) socket.write('250 OK\r\n');
              else { greySeen.add(addr); socket.write('450 Try again later\r\n'); }
            } else if (addr === 'slow@mock.test') {
              // never reply — client must time out
            } else if (addr.startsWith('x') && addr.includes('@mock.test')) {
              socket.write('550 No such mailbox\r\n'); // random catch-all probe
            } else {
              socket.write('550 No such mailbox\r\n');
            }
          } else if (c === 'QUIT') {
            socket.write('221 Bye\r\n');
            socket.end();
          } else {
            socket.write('500 Unknown command\r\n');
          }
        }
      });
    });
    server.listen(MOCK_SMTP_PORT, '127.0.0.1', () => resolve(server));
  });
}

// --- Mock SOCKS5 proxy (no auth): tunnels to wherever the client asks -----
function mockSocksServer() {
  return new Promise((resolve) => {
    const server = net.createServer((client) => {
      let stage = 0;
      let buf = Buffer.alloc(0);
      client.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (stage === 0) {
          if (buf.length < 2) return;
          client.write(Buffer.from([0x05, 0x00])); // no auth
          buf = Buffer.alloc(0);
          stage = 1;
        } else if (stage === 1) {
          if (buf.length < 4) return;
          const atyp = buf[3];
          let host; let off;
          if (atyp === 0x03) {
            const len = buf[4];
            if (buf.length < 5 + len + 2) return;
            host = buf.slice(5, 5 + len).toString('utf8');
            off = 5 + len;
          } else if (atyp === 0x01) {
            if (buf.length < 10) return;
            host = buf.slice(4, 8).join('.');
            off = 8;
          } else { client.destroy(); return; }
          const port = buf.readUInt16BE(off);
          const target = net.connect({ host, port }, () => {
            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            client.pipe(target);
            target.pipe(client);
          });
          target.on('error', () => client.destroy());
          stage = 2;
        }
      });
      client.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// --- Test runner -----------------------------------------------------------
let passed = 0;
let failed = 0;
async function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}

async function main() {
  const smtp = await mockSmtpServer();
  const socksSrv = await mockSocksServer();
  const socksPort = socksSrv.address().port;
  const opts = { smtpPort: MOCK_SMTP_PORT, timeoutMs: 3000, helo: 'test.local', mailFrom: 'verify@test.local' };
  console.log('Mock SMTP on :' + MOCK_SMTP_PORT + ', mock SOCKS5 on :' + socksPort);
  console.log('\nSingle-address checks:');

  let r = await verifyEmail('valid@mock.test', opts);
  check('valid mailbox -> valid', r.status === 'valid', JSON.stringify(r));

  r = await verifyEmail('invalid@mock.test', opts);
  check('missing mailbox -> invalid', r.status === 'invalid', JSON.stringify(r));

  r = await verifyEmail('someone@catchall.test', opts);
  check('catch-all domain -> risky', r.status === 'risky', JSON.stringify(r));

  r = await verifyEmail('grey@mock.test', opts);
  check('greylisted then accepted -> valid', r.status === 'valid', JSON.stringify(r));

  r = await verifyEmail('slow@mock.test', { ...opts, timeoutMs: 1500 });
  check('silent server -> unknown with the SMTP step identified', r.status === 'unknown' && /RCPT reply/.test(r.reason), JSON.stringify(r));

  r = await verifyEmail('not-an-email', opts);
  check('bad syntax -> invalid', r.status === 'invalid', JSON.stringify(r));

  r = await verifyEmail('x@mailinator.com', opts);
  check('disposable domain -> disposable', r.status === 'disposable', JSON.stringify(r));

  r = await verifyEmail('a@nodomain.test', opts);
  check('domain with no MX -> invalid', r.status === 'invalid', JSON.stringify(r));

  r = await verifyEmail('info@mock.test', opts);
  check('role address flagged', r.status === 'valid' && r.flags.includes('role'), JSON.stringify(r));

  console.log('\nProxy check:');
  const { testProxy } = require('../lib/proxypool');
  const proxyCheck = await testProxy(
    { host: '127.0.0.1', port: socksPort, username: '', password: '' },
    3000,
    { host: '127.0.0.1', port: MOCK_SMTP_PORT },
  );
  check('proxy preflight recognizes a reachable SMTP greeting', proxyCheck === true);

  r = await verifyEmail('valid@mock.test', {
    ...opts,
    proxy: { host: '127.0.0.1', port: socksPort, username: '', password: '' },
  });
  check('valid mailbox via SOCKS5 proxy -> valid', r.status === 'valid', JSON.stringify(r));

  r = await verifyEmail('valid@mock.test', {
    ...opts,
    proxy: { host: '127.0.0.1', port: 1, username: '', password: '' },
  });
  check('dead proxy -> unknown (not a crash)', r.status === 'unknown', JSON.stringify(r));

  console.log('\nProxy rotation check (auto mode):');
  const { createRotator } = require('../lib/proxypool');
  const deadProxy = { host: '127.0.0.1', port: 1, username: '', password: '' };
  const goodProxy = { host: '127.0.0.1', port: socksPort, username: '', password: '' };

  r = await verifyEmail('valid@mock.test', { ...opts, rotator: createRotator([deadProxy, goodProxy]) });
  check('dead proxy first, rotation saves the check -> valid', r.status === 'valid', JSON.stringify(r));

  r = await verifyEmail('valid@mock.test', { ...opts, rotator: createRotator([deadProxy, { ...deadProxy, port: 2 }]) });
  check('all proxies dead -> unknown (not a crash)', r.status === 'unknown', JSON.stringify(r));

  console.log('\nLookup-failure check (regression: gmail must never read as "no MX"):');
  {
    const savedMx = dns.promises.resolveMx;
    const savedFetch = global.fetch;
    global.fetch = async (url) => ({
      ok: true,
      json: async () => String(url).includes('type=MX')
        ? { Status: 0, Answer: [{ type: 15, data: '10 mail.mock.test.' }] }
        : { Status: 0, Answer: [{ type: 1, data: '192.0.2.1' }] },
    });
    const recovered = await require('../lib/verifier')._test.lookupMx('recovered.test');
    check('local ENOTFOUND is recovered by independent DNS lookup', recovered.records?.[0] === 'mail.mock.test', JSON.stringify(recovered));

    dns.promises.resolveMx = async () => {
      const e = new Error('queryMx EREFUSED');
      e.code = 'EREFUSED';
      throw e;
    };
    global.fetch = async () => { throw new Error('network down'); };
    const rr = await verifyEmail('someone@fail.test', opts);
    check('all DNS lookups failing -> unknown, not invalid', rr.status === 'unknown' && /DNS lookup failed/.test(rr.reason), JSON.stringify(rr));
    dns.promises.resolveMx = savedMx;
    global.fetch = savedFetch;
  }

  console.log('\nBulk list check:');
  const observedStages = [];
  const sameDomain = await verifyList(
    ['valid@mock.test', 'info@mock.test'],
    { ...opts, concurrency: 2, onStage: (_email, stage) => observedStages.push(stage) },
  );
  check('concurrent addresses share a completed MX lookup', sameDomain.every((x) => x.status === 'valid'), JSON.stringify(sameDomain));
  check('live progress reports connection and mailbox stages', ['syntax', 'dns', 'connect', 'mailbox', 'complete'].every((stage) => observedStages.includes(stage)), JSON.stringify(observedStages));

  const list = await verifyList(
    ['valid@mock.test', 'invalid@mock.test', 'someone@catchall.test', 'x@mailinator.com', 'not-an-email'],
    { ...opts, concurrency: 3 },
  );
  const counts = {};
  for (const x of list) counts[x.status] = (counts[x.status] || 0) + 1;
  check('bulk returns all 5 results', list.length === 5, JSON.stringify(counts));
  check('bulk counts match', counts.valid === 1 && counts.invalid === 2 && counts.risky === 1 && counts.disposable === 1, JSON.stringify(counts));

  smtp.close();
  socksSrv.close();
  dns.promises.resolveMx = origResolveMx;
  dns.promises.resolve4 = origResolve4;

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
