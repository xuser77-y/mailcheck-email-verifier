// MailCheck frontend — vanilla JS, no framework.
const $ = (id) => document.getElementById(id);
const EMAIL_RE = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/g;

let allResults = [];
let activeFilter = 'all';
let running = false;

function extractEmails(text) {
  const found = (text.match(EMAIL_RE) || []).map((e) => e.toLowerCase());
  return [...new Set(found)];
}

function currentList() {
  return extractEmails($('pasteBox').value);
}

function updateCount() {
  const n = currentList().length;
  $('listCount').textContent = n + ' unique address' + (n === 1 ? '' : 'es');
}

// --- File input / drag & drop -------------------------------------------
const dropzone = $('dropzone');
const fileInput = $('fileInput');

$('browseBtn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); });
['dragenter', 'dragover'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('drag'); }));
dropzone.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) loadFile(f);
});

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result || '');
    const existing = $('pasteBox').value ? $('pasteBox').value + '\n' : '';
    $('pasteBox').value = existing + text;
    $('fileName').textContent = 'Loaded: ' + file.name;
    updateCount();
  };
  reader.onerror = () => { $('fileName').textContent = 'Could not read ' + file.name; };
  reader.readAsText(file);
}

$('pasteBox').addEventListener('input', updateCount);
$('clearBtn').addEventListener('click', () => {
  $('pasteBox').value = '';
  $('fileName').textContent = '';
  fileInput.value = '';
  updateCount();
});

// --- Results rendering ---------------------------------------------------
function badge(status) {
  return '<span class="badge ' + status + '">' + status + '</span>';
}

function renderTable() {
  const tbody = document.querySelector('#resultsTable tbody');
  const rows = allResults.filter((r) => activeFilter === 'all' || r.status === activeFilter);
  if (!rows.length) {
    tbody.innerHTML = '<tr class="empty"><td colspan="4">No results' + (activeFilter === 'all' ? ' yet.' : ' with this status.') + '</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r) =>
    '<tr><td class="mono">' + escapeHtml(r.email) + '</td><td>' + badge(r.status) + '</td><td>' +
    escapeHtml(r.reason || '') + '</td><td>' + (r.ms != null ? r.ms + ' ms' : '–') + '</td></tr>'
  ).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

document.querySelectorAll('#filterRow .chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#filterRow .chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    activeFilter = chip.dataset.filter;
    renderTable();
  });
});

function setStat(id, v) { $(id).textContent = v; }

function renderSummary(s) {
  setStat('stTotal', s.total);
  setStat('stValid', s.valid);
  setStat('stInvalid', s.invalid);
  setStat('stRisky', s.risky);
  setStat('stUnknown', s.unknown);
  setStat('stDisp', s.disposable);
  setStat('stRate', s.successRate + '%');
  setStat('stDeliverable', s.deliverableRate + '%');

  // Analysis bullets.
  const lines = [];
  if (s.total === 0) lines.push('Nothing was checked.');
  else {
    if (s.successRate >= 80) lines.push('Strong list — ' + s.successRate + '% of addresses are confirmed mailboxes.');
    else if (s.successRate >= 50) lines.push('Mixed list — about half the addresses are confirmed. The invalid ones are safe to drop before you send anything.');
    else lines.push('Weak list — only ' + s.successRate + '% confirmed. Sending to this list as-is would bounce hard and hurt your sender reputation.');
    if (s.invalid) lines.push(s.invalid + ' invalid address' + (s.invalid === 1 ? '' : 'es') + ' — remove these, they will bounce.');
    if (s.risky) lines.push(s.risky + ' on catch-all domains — those servers accept everything, so the mailbox could not be confirmed. Treat them as “maybe”.');
    if (s.unknown) lines.push(s.unknown + ' unknown — the mail server could not be reached or greylisted the probe. Re-run these later, or from a different IP / proxy.');
    if (s.disposable) lines.push(s.disposable + ' disposable address' + (s.disposable === 1 ? '' : 'es') + ' — temporary inboxes, not real leads.');
    if (s.duplicatesRemoved) lines.push(s.duplicatesRemoved + ' duplicate' + (s.duplicatesRemoved === 1 ? '' : 's') + ' removed before checking.');
  }
  $('analysisList').innerHTML = lines.map((l) => '<li>' + escapeHtml(l) + '</li>').join('');
  $('analysis').hidden = false;

  // Domain table.
  const dt = document.querySelector('#domainTable tbody');
  dt.innerHTML = (s.byDomain || []).map((d) =>
    '<tr><td class="mono">' + escapeHtml(d.domain) + '</td><td>' + d.total + '</td><td>' + d.valid + '</td><td>' + d.validRate + '%</td></tr>'
  ).join('') || '<tr class="empty"><td colspan="4">No domains.</td></tr>';

  $('exportBox').hidden = false;
  $('filterRow').hidden = false;
}

// --- Run -----------------------------------------------------------------
$('runBtn').addEventListener('click', async () => {
  if (running) return;
  const emails = currentList();
  if (!emails.length) {
    $('runStatus').textContent = 'Add some email addresses first — paste them or upload a file.';
    return;
  }
  running = true;
  allResults = [];
  activeFilter = 'all';
  document.querySelectorAll('#filterRow .chip').forEach((c) => c.classList.toggle('active', c.dataset.filter === 'all'));
  $('runBtn').disabled = true;
  $('runBtn').textContent = 'Checking…';
  $('runStatus').textContent = '';
  $('progressWrap').hidden = false;
  $('analysis').hidden = true;
  $('exportBox').hidden = true;
  $('filterRow').hidden = true;
  document.querySelector('#resultsTable tbody').innerHTML = '<tr class="empty"><td colspan="4">Checking… results appear as they finish.</td></tr>';
  ['stTotal', 'stValid', 'stInvalid', 'stRisky', 'stUnknown', 'stDisp', 'stRate', 'stDeliverable'].forEach((id) => setStat(id, '–'));

  const options = {
    concurrency: parseInt($('concurrency').value, 10) || 5,
    timeoutMs: parseInt($('timeout').value, 10) || 12000,
    helo: $('helo').value.trim() || 'mailcheck.local',
    mailFrom: $('mailFrom').value.trim() || 'verify@mailcheck.local',
  };
  const proxyHost = $('proxyHost').value.trim();
  if ($('autoProxy').checked) {
    options.autoProxy = true;
  } else if (proxyHost) {
    options.proxy = {
      host: proxyHost,
      port: parseInt($('proxyPort').value, 10) || 1080,
      username: $('proxyUser').value,
      password: $('proxyPass').value,
    };
  }

  try {
    const res = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails, options }),
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || ('Server error ' + res.status));
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let summary = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.type === 'status') {
          $('runStatus').textContent = msg.message;
        } else if (msg.type === 'result') {
          allResults.push(msg.result);
          const pct = Math.round((allResults.length / emails.length) * 100);
          $('progressBar').style.width = pct + '%';
          $('progressText').textContent = allResults.length + ' / ' + emails.length;
          renderTable();
        } else if (msg.type === 'done') {
          summary = msg.summary;
        } else if (msg.type === 'error') {
          throw new Error(msg.error);
        }
      }
    }
    if (summary) {
      renderSummary(summary);
      $('runStatus').textContent = 'Done in ' + (summary.ms / 1000).toFixed(1) + 's — ' + summary.valid + ' valid of ' + summary.total + '.';
    } else {
      $('runStatus').textContent = 'Finished, but no summary was returned.';
    }
  } catch (e) {
    $('runStatus').textContent = 'Error: ' + e.message;
  } finally {
    running = false;
    $('runBtn').disabled = false;
    $('runBtn').textContent = 'Verify list';
  }
});

// --- Export ---------------------------------------------------------------
$('downloadBtn').addEventListener('click', () => {
  const format = $('exportFormat').value;
  const scope = $('exportScope').value;
  const rows = allResults.filter((r) => scope === 'all' || r.status === scope);
  if (!rows.length) { $('runStatus').textContent = 'Nothing to download for that selection.'; return; }

  let content, filename, mime;
  if (format === 'json') {
    content = JSON.stringify(rows, null, 2);
    filename = 'mailcheck-results.json';
    mime = 'application/json';
  } else if (format === 'txt') {
    content = rows.map((r) => r.email).join('\n') + '\n';
    filename = 'mailcheck-results.txt';
    mime = 'text/plain';
  } else {
    const head = 'email,status,reason,domain,ms\n';
    const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    content = head + rows.map((r) => [r.email, r.status, r.reason, r.domain, r.ms].map(esc).join(',')).join('\n') + '\n';
    filename = 'mailcheck-results.csv';
    mime = 'text/csv';
  }
  const blob = new Blob([content], { type: mime + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

updateCount();
