// MailCheck frontend — vanilla JS, no framework.
const $ = (id) => document.getElementById(id);
const EMAIL_RE = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/g;

let allResults = [];
let runEmails = [];
let stages = [];
let activeFilter = 'all';
let running = false;
let activeIndex = -1;

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
  const labels = { risky: 'Review', disposable: 'Disposable', pending: 'In progress' };
  return '<span class="badge ' + status + '">' + (labels[status] || status) + '</span>';
}

function renderTable() {
  const tbody = document.querySelector('#resultsTable tbody');
  const indexes = runEmails.map((_, i) => i).filter((i) => activeFilter === 'all' || (allResults[i] && allResults[i].status === activeFilter));
  if (!indexes.length) {
    tbody.innerHTML = '<tr class="empty"><td colspan="4"><strong>' + (runEmails.length ? 'No addresses in this view' : 'Your results will appear here') + '</strong><small>' + (runEmails.length ? 'Choose another status filter.' : 'Add a list to see each address update as it’s checked.') + '</small></td></tr>';
    return;
  }
  tbody.innerHTML = indexes.map(rowMarkup).join('');
}

function rowMarkup(index) {
  const result = allResults[index];
  const current = stages[index];
  const state = result ? result.status : (current && current.stage === 'complete' ? 'unknown' : 'pending');
  const detail = result ? (result.reason || '') : (current ? current.detail : 'Waiting for a check');
  return '<tr data-index="' + index + '"><td class="mono">' + escapeHtml(runEmails[index]) + '</td><td>' + badge(state) + '</td><td>' + escapeHtml(detail) + '</td><td>' + (result && result.ms != null ? result.ms + ' ms' : '–') + '</td></tr>';
}

function updateRow(index) {
  const row = document.querySelector('#resultsTable tbody tr[data-index="' + index + '"]');
  if (row) row.outerHTML = rowMarkup(index);
}

function updateActivity(index, detail) {
  if (index >= 0 && runEmails[index]) {
    activeIndex = index;
    $('activityEmail').textContent = runEmails[index];
    $('activityStage').textContent = detail || 'Working';
  }
  const completed = allResults.reduce((count, result) => count + (result ? 1 : 0), 0);
  const active = stages.reduce((count, item, i) => count + (!allResults[i] && item && item.stage !== 'complete' ? 1 : 0), 0);
  const percent = runEmails.length ? Math.round(completed * 100 / runEmails.length) : 0;
  $('progressLabel').textContent = completed === runEmails.length ? 'Checks complete' : (active ? active + ' active' : 'Preparing checks') + ' · ' + percent + '% complete';
  $('progressText').textContent = completed + ' / ' + runEmails.length;
  $('progressBar').style.width = percent + '%';
  $('resultsCaption').textContent = completed === runEmails.length ? 'Check complete' : percent + '% complete';
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
    if (s.unknown) {
      const timedOut = allResults.filter((r) => r && /timed out on port 25/i.test(r.reason || '')).length;
      if (timedOut === s.unknown) {
        lines.push(s.unknown + ' checks timed out while opening SMTP on port 25. This usually means the network or hosting provider blocks outbound SMTP; these addresses are unconfirmed, not invalid. Ask the provider to allow outbound port 25, or run from a network that permits it.');
      } else {
        lines.push(s.unknown + ' unknown — a server could not be reached or temporarily refused the check. Unknown does not mean invalid; see each row for its specific reason.');
      }
    }
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
  $('resultsCaption').textContent = 'Check complete';
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
  runEmails = emails;
  allResults = new Array(emails.length);
  stages = new Array(emails.length);
  activeFilter = 'all';
  document.querySelectorAll('#filterRow .chip').forEach((c) => c.classList.toggle('active', c.dataset.filter === 'all'));
  $('runBtn').disabled = true;
  $('runBtn').querySelector('span').textContent = 'Checking your list…';
  $('runStatus').textContent = '';
  $('progressWrap').hidden = false;
  $('resultsCaption').textContent = 'Starting checks';
  $('activityEmail').textContent = 'Starting check';
  $('activityStage').textContent = 'Looking up domains and connecting to mail servers';
  $('progressLabel').textContent = 'Preparing checks';
  $('progressText').textContent = '0 / ' + emails.length;
  $('progressBar').style.width = '0%';
  $('analysis').hidden = true;
  $('exportBox').hidden = true;
  $('filterRow').hidden = true;
  document.querySelector('#resultsTable tbody').innerHTML = '';
  renderTable();
  ['stTotal', 'stValid', 'stInvalid', 'stRisky', 'stUnknown', 'stDisp', 'stRate', 'stDeliverable'].forEach((id) => setStat(id, '–'));

  const options = {
    concurrency: parseInt($('concurrency').value, 10) || 5,
    timeoutMs: parseInt($('timeout').value, 10) || 12000,
    helo: $('helo').value.trim() || 'mailcheck.local',
    mailFrom: $('mailFrom').value.trim() || 'verify@mailcheck.local',
  };
  const proxyHost = $('proxyHost').value.trim();
  if (proxyHost) {
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
        if (msg.type === 'stage') {
          stages[msg.index] = msg;
          updateRow(msg.index);
          updateActivity(msg.index, msg.detail);
        } else if (msg.type === 'result') {
          allResults[msg.index] = msg.result;
          stages[msg.index] = { stage: 'complete', detail: msg.result.reason };
          updateRow(msg.index);
          updateActivity(msg.index, msg.result.reason);
        } else if (msg.type === 'done') {
          summary = msg.summary;
        } else if (msg.type === 'error') {
          throw new Error(msg.error);
        }
      }
    }
    if (summary) {
      renderSummary(summary);
      $('runStatus').textContent = 'Finished in ' + (summary.ms / 1000).toFixed(1) + 's. ' + summary.valid + ' of ' + summary.total + ' addresses confirmed.';
    } else {
      $('runStatus').textContent = 'Finished, but no summary was returned.';
    }
  } catch (e) {
    $('runStatus').textContent = 'Error: ' + e.message;
  } finally {
    running = false;
    $('runBtn').disabled = false;
    $('runBtn').querySelector('span').textContent = 'Check email list';
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
