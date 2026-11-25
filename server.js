// MailCheck server — zero dependencies.
// Serves the frontend and streams verification results as NDJSON:
//   POST /api/verify  { emails: [...], options: {...} }
//     -> {"type":"result","result":{...}} per email, then {"type":"done","summary":{...}}
//   GET  /api/health  -> {"ok":true}
const http = require('http');
const fs = require('fs');
const path = require('path');
const { verifyList } = require('./lib/verifier');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const EMAIL_EXTRACT = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/g;

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function parseOptions(body) {
  const o = (body && body.options) || {};
  const out = {};
  if (Number.isFinite(+o.concurrency)) out.concurrency = Math.min(20, Math.max(1, +o.concurrency));
  if (Number.isFinite(+o.timeoutMs)) out.timeoutMs = Math.min(30000, Math.max(3000, +o.timeoutMs));
  if (typeof o.helo === 'string' && o.helo.trim()) out.helo = o.helo.trim().slice(0, 63);
  if (typeof o.mailFrom === 'string' && o.mailFrom.trim()) out.mailFrom = o.mailFrom.trim().slice(0, 120);
  if (o.proxy && typeof o.proxy.host === 'string' && o.proxy.host.trim()) {
    out.proxy = {
      host: o.proxy.host.trim(),
      port: Math.min(65535, Math.max(1, +o.proxy.port || 1080)),
      username: typeof o.proxy.username === 'string' ? o.proxy.username : '',
      password: typeof o.proxy.password === 'string' ? o.proxy.password : '',
    };
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5 * 1024 * 1024) { // 5 MB cap
        try { req.destroy(); } catch (_) {}
        reject(new Error('request too large'));
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/verify') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        return sendJson(res, 400, { error: 'Invalid JSON body: ' + e.message });
      }
      const rawList = Array.isArray(body.emails) ? body.emails : [];
      // Extract, trim, dedupe (case-insensitive), cap at 10,000 per run.
      const seen = new Set();
      const emails = [];
      for (const item of rawList) {
        const e = String(item || '').trim().toLowerCase();
        if (!e || seen.has(e)) continue;
        seen.add(e);
        emails.push(e);
        if (emails.length >= 10000) break;
      }
      if (!emails.length) return sendJson(res, 400, { error: 'No email addresses received.' });

      const options = parseOptions(body);
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      const counts = { total: emails.length, valid: 0, invalid: 0, risky: 0, unknown: 0, disposable: 0 };
      const byDomain = {};
      const started = Date.now();
      try {
        await verifyList(emails, {
          ...options,
          onStage: (email, stage, detail, index) => {
            res.write(JSON.stringify({ type: 'stage', index, email, stage, detail }) + '\n');
          },
          onResult: (r, index) => {
            counts[r.status] = (counts[r.status] || 0) + 1;
            if (r.domain) {
              byDomain[r.domain] = byDomain[r.domain] || { total: 0, valid: 0 };
              byDomain[r.domain].total++;
              if (r.status === 'valid') byDomain[r.domain].valid++;
            }
            res.write(JSON.stringify({ type: 'result', index, result: r }) + '\n');
          },
        });
        const summary = {
          ...counts,
          duplicatesRemoved: rawList.length - emails.length,
          successRate: counts.total ? +(100 * counts.valid / counts.total).toFixed(1) : 0,
          deliverableRate: counts.total ? +(100 * (counts.valid + counts.risky) / counts.total).toFixed(1) : 0,
          ms: Date.now() - started,
          byDomain: Object.entries(byDomain)
            .map(([domain, d]) => ({ domain, ...d, validRate: +(100 * d.valid / d.total).toFixed(1) }))
            .sort((a, b) => b.total - a.total),
        };
        res.write(JSON.stringify({ type: 'done', summary }) + '\n');
      } catch (e) {
        res.write(JSON.stringify({ type: 'error', error: e.message }) + '\n');
      }
      return res.end();
    }

    // Static files.
    if (req.method === 'GET') {
      let filePath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
      filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
      const full = path.join(PUBLIC_DIR, filePath);
      if (!full.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
        return sendJson(res, 404, { error: 'not found' });
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      return fs.createReadStream(full).pipe(res);
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
    else try { res.end(); } catch (_) {}
  }
});

server.listen(PORT, () => {
  console.log('MailCheck running at http://localhost:' + PORT);
});
