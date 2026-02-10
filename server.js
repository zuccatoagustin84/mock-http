/**
 * Mock HTTP Output server with runtime chaos control (MailHog-style).
 *
 * Upload endpoint(s) are read from config.json (Ocelot-style: method + path).
 * The response depends on the current "behavior" configured via the UI panel.
 *
 * Control panel:  GET  /           -> Inbox + chaos control panel
 * API (control):  GET  /api/behavior   -> current behavior (JSON)
 *                 POST /api/behavior   -> set behavior    (JSON body)
 *                 GET  /api/inbox      -> request log     (JSON)
 *                 POST /api/inbox/clear -> clear log
 * Upload:         From config (method + path or paths[]) -> responds according to current behavior
 * Ping:           GET  /printapi/ping  -> 200 (always, not affected by chaos)
 * Health:         GET  /health         -> 200 (always, not affected by chaos)
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Config (Ocelot-style: verb + route from file) ───────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');
const DEFAULT_UPLOAD = { method: 'POST', path: '/upload' };

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    const upload = cfg?.upload ?? DEFAULT_UPLOAD;
    const method = (upload.method || 'POST').toString().toUpperCase();
    const pathOrPaths = upload.path;
    const paths = Array.isArray(pathOrPaths)
      ? pathOrPaths
          .map((p) => (typeof p === 'string' && p.trim() ? (p.trim().startsWith('/') ? p.trim() : '/' + p.trim()) : null))
          .filter(Boolean)
      : [pathOrPaths && pathOrPaths.toString().trim().startsWith('/') ? pathOrPaths.toString().trim() : '/' + (pathOrPaths?.toString().trim() || 'upload')];
    return { method, paths: paths.length ? paths : ['/upload'] };
  } catch (e) {
    console.warn('Could not load config from', CONFIG_PATH, '(using defaults):', e.message);
    return { method: 'POST', paths: ['/upload'] };
  }
}

const uploadRoute = loadConfig();

app.use(express.json());

// ── Behavior (chaos) state ──────────────────────────────────────────────────
const DEFAULT_BEHAVIOR = {
  mode: 'normal', // 'normal' | 'error' | 'timeout'
  errorCode: 500, // used when mode === 'error'
  errorMessage: '', // custom error message (optional, auto-generated if empty)
  delayMs: 0, // extra latency added before responding (any mode)
};

let behavior = { ...DEFAULT_BEHAVIOR };

// ── Request log (newest first) ──────────────────────────────────────────────
const MAX_LOG = 200;
const receivedLog = [];

function logReceived(req, responseStatus, note) {
  const file = req.file || req.files?.pdf;
  receivedLog.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    time: new Date().toISOString(),
    method: req.method,
    path: req.path,
    fileName: file?.originalname || file?.name || null,
    fileSize: file?.size ?? null,
    hasAuth: !!req.headers.authorization,
    responseStatus,
    note: note || null,
    chaosMode: behavior.mode,
  });
  if (receivedLog.length > MAX_LOG) receivedLog.pop();
}

// ── Multer (in-memory) ──────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ── Helpers ─────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatBytes(n) {
  if (n == null) return '–';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

const ERROR_MESSAGES = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  408: 'Request Timeout',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Behavior API ────────────────────────────────────────────────────────────
app.get('/api/behavior', (_req, res) => {
  res.json(behavior);
});

app.post('/api/behavior', (req, res) => {
  const b = req.body;
  if (b.mode && !['normal', 'error', 'timeout'].includes(b.mode)) {
    return res.status(400).json({ error: 'mode must be normal, error, or timeout' });
  }
  if (b.mode) behavior.mode = b.mode;
  if (b.errorCode != null) behavior.errorCode = Number(b.errorCode) || 500;
  if (b.errorMessage != null) behavior.errorMessage = String(b.errorMessage);
  if (b.delayMs != null) behavior.delayMs = Math.max(0, Number(b.delayMs) || 0);
  res.json(behavior);
});

// Convenience: reset to normal
app.post('/api/behavior/reset', (_req, res) => {
  behavior = { ...DEFAULT_BEHAVIOR };
  res.json(behavior);
});

// ── Routes API (what we are listening on) ───────────────────────────────────
app.get('/api/routes', (_req, res) => {
  res.json({
    upload: {
      method: uploadRoute.method,
      paths: uploadRoute.paths,
    },
  });
});

// ── Inbox API ───────────────────────────────────────────────────────────────
app.get('/api/inbox', (_req, res) => {
  res.json(receivedLog);
});

app.post('/api/inbox/clear', (_req, res) => {
  receivedLog.length = 0;
  res.json({ ok: true });
});

// ── Upload handler (single handler for all uploads) ─────────────────────────
async function handle(req, res) {
  // Apply configured delay
  if (behavior.delayMs > 0) {
    await delay(behavior.delayMs);
  }

  if (behavior.mode === 'timeout') {
    // Don't respond — let the client timeout
    logReceived(req, 0, 'timeout (no response sent)');
    // just hang; express will keep the connection open until client gives up
    return;
  }

  if (behavior.mode === 'error') {
    const code = behavior.errorCode || 500;
    const msg = behavior.errorMessage || ERROR_MESSAGES[code] || `Error ${code}`;
    logReceived(req, code, `chaos: ${msg}`);
    return res.status(code).json({ error: msg });
  }

  // Normal mode
  logReceived(req, 200);
  res.status(200).json({
    ok: true,
    message: 'PDF received',
    filename: req.file?.originalname || req.file?.name || null,
  });
}

// Register upload route(s) from config (Ocelot-style)
let uploadMethod = uploadRoute.method.toLowerCase();
if (typeof app[uploadMethod] !== 'function') {
  console.warn('Invalid upload method in config:', uploadRoute.method, '; using POST');
  uploadRoute.method = 'POST';
  uploadMethod = 'post';
}
uploadRoute.paths.forEach((p) => {
  app[uploadMethod](p, upload.single('pdf'), handle);
});

// ── Ping (not affected by chaos) ────────────────────────────────────────────
app.get('/printapi/ping', (_req, res) => {
  res.status(200).json({ status: 'ok', message: 'pong' });
});

// ── Health (not affected by chaos) ──────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// ── UI: Inbox + Chaos Control Panel ─────────────────────────────────────────
app.get('/', (_req, res) => {
  const rows =
    receivedLog
      .map((e) => {
        const statusClass =
          e.responseStatus === 0
            ? 'timeout'
            : e.responseStatus >= 500
              ? '5xx'
              : e.responseStatus >= 400
                ? '4xx'
                : '2xx';
        return `<tr>
          <td><time datetime="${e.time}">${new Date(e.time).toLocaleString()}</time></td>
          <td><code>${e.method} ${e.path}</code></td>
          <td>${e.fileName ? escapeHtml(e.fileName) : '–'}</td>
          <td>${formatBytes(e.fileSize)}</td>
          <td>${e.hasAuth ? '✓' : '–'}</td>
          <td><span class="status status-${statusClass}">${e.responseStatus === 0 ? 'TIMEOUT' : e.responseStatus}</span></td>
          <td class="note">${e.note ? escapeHtml(e.note) : ''}</td>
        </tr>`;
      })
      .join('') ||
    '<tr><td colspan="7" class="empty">No requests yet. Send a PDF to <code>' +
      uploadRoute.paths.map((p) => uploadRoute.method + ' ' + p).join('</code> or <code>') +
      '</code>.</td></tr>';

  const modeNormal = behavior.mode === 'normal' ? 'checked' : '';
  const modeError = behavior.mode === 'error' ? 'checked' : '';
  const modeTimeout = behavior.mode === 'timeout' ? 'checked' : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mock HTTP Output – Control Panel</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 1100px; margin: 0 auto; padding: 1rem; background: #fafafa; color: #333; }
    h1 { font-size: 1.4rem; margin: 0 0 0.5rem; }
    a { color: #0066cc; }

    /* Chaos panel */
    .panel { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
    .panel h2 { font-size: 1.1rem; margin: 0 0 0.75rem; }
    .panel-row { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; margin-bottom: 0.5rem; }
    .mode-btn { padding: 0.5rem 1rem; border: 2px solid #ddd; border-radius: 6px; background: #fff; cursor: pointer; font-size: 0.95rem; transition: all 0.15s; }
    .mode-btn:hover { border-color: #999; }
    .mode-btn.active-normal { border-color: #0a0; background: #e6ffe6; color: #060; font-weight: 600; }
    .mode-btn.active-error { border-color: #c00; background: #ffe6e6; color: #600; font-weight: 600; }
    .mode-btn.active-timeout { border-color: #c60; background: #fff3e0; color: #630; font-weight: 600; }
    .field { display: flex; align-items: center; gap: 0.5rem; }
    .field label { font-size: 0.9rem; color: #666; white-space: nowrap; }
    .field select, .field input { padding: 0.35rem 0.5rem; border: 1px solid #ccc; border-radius: 4px; font-size: 0.9rem; }
    .field select { min-width: 80px; }
    .field input[type="number"] { width: 80px; }
    .status-indicator { display: inline-block; padding: 0.3rem 0.75rem; border-radius: 20px; font-weight: 600; font-size: 0.85rem; }
    .status-normal { background: #e6ffe6; color: #060; }
    .status-error { background: #ffe6e6; color: #900; }
    .status-timeout { background: #fff3e0; color: #930; }
    .btn-reset { padding: 0.35rem 0.75rem; border: 1px solid #ccc; border-radius: 4px; background: #f5f5f5; cursor: pointer; font-size: 0.85rem; }
    .btn-reset:hover { background: #eee; }
    .btn-clear { padding: 0.35rem 0.75rem; border: 1px solid #dcc; border-radius: 4px; background: #fff5f5; cursor: pointer; font-size: 0.85rem; color: #900; }
    .btn-clear:hover { background: #fee; }

    /* Table */
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #ddd; border-radius: 8px; overflow: hidden; }
    th, td { text-align: left; padding: 0.45rem 0.65rem; border-bottom: 1px solid #eee; font-size: 0.9rem; }
    th { background: #f5f5f5; font-weight: 600; font-size: 0.85rem; color: #555; }
    .empty { text-align: center; padding: 2rem; color: #999; }
    code { background: #f0f0f0; padding: 0.1em 0.35em; border-radius: 3px; font-size: 0.85em; }
    .note { color: #888; font-size: 0.85rem; max-width: 200px; overflow: hidden; text-overflow: ellipsis; }
    .status { font-weight: 600; }
    .status-2xx { color: #0a0; }
    .status-4xx { color: #c60; }
    .status-5xx { color: #c00; }
    .status-timeout { color: #930; }
    .meta { color: #888; font-size: 0.85rem; margin-bottom: 0.75rem; }
  </style>
</head>
<body>
  <h1>Mock HTTP Output – Control Panel</h1>
  <p class="meta">
    <a href="/api/inbox">JSON inbox</a> · <a href="/api/behavior">JSON behavior</a> · <a href="/api/routes">JSON routes</a> · <a href="/health">health</a> · <a href="/printapi/ping">ping</a>
  </p>

  <div class="panel listening-panel">
    <h2>Listening</h2>
    <p class="listening-routes">Upload: <code>${uploadRoute.paths.map((p) => uploadRoute.method + ' ' + p).join('</code>, <code>')}</code></p>
    <p class="meta">From <code>config.json</code> · <a href="/api/routes">/api/routes</a></p>
  </div>

  <div class="panel">
    <h2>Chaos Control</h2>
    <div class="panel-row">
      <span>Current: <span id="statusBadge" class="status-indicator status-${behavior.mode}">${behavior.mode.toUpperCase()}${behavior.mode === 'error' ? ' ' + behavior.errorCode : ''}${behavior.delayMs > 0 ? ' +' + behavior.delayMs + 'ms' : ''}</span></span>
    </div>
    <div class="panel-row">
      <button class="mode-btn ${modeNormal ? 'active-normal' : ''}" onclick="setMode('normal')">Normal (200)</button>
      <button class="mode-btn ${modeError ? 'active-error' : ''}" onclick="setMode('error')">Error</button>
      <button class="mode-btn ${modeTimeout ? 'active-timeout' : ''}" onclick="setMode('timeout')">Timeout (hang)</button>
    </div>
    <div class="panel-row">
      <div class="field">
        <label>Error code:</label>
        <select id="errorCode" onchange="updateBehavior()">
          ${[400, 401, 403, 404, 408, 429, 500, 502, 503, 504].map((c) => `<option value="${c}" ${behavior.errorCode === c ? 'selected' : ''}>${c} ${ERROR_MESSAGES[c] || ''}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Delay (ms):</label>
        <input type="number" id="delayMs" value="${behavior.delayMs}" min="0" max="120000" step="500" onchange="updateBehavior()" />
      </div>
      <button class="btn-reset" onclick="resetBehavior()">Reset to defaults</button>
      <button class="btn-clear" onclick="clearLog()">Clear log</button>
    </div>
  </div>

  <table>
    <thead><tr><th>Time</th><th>Request</th><th>File</th><th>Size</th><th>Auth</th><th>Status</th><th>Note</th></tr></thead>
    <tbody id="logBody">${rows}</tbody>
  </table>

  <script>
    async function api(method, url, body) {
      const opts = { method, headers: { 'Content-Type': 'application/json' } };
      if (body) opts.body = JSON.stringify(body);
      const r = await fetch(url, opts);
      return r.json();
    }

    async function setMode(mode) {
      await api('POST', '/api/behavior', { mode });
      location.reload();
    }

    async function updateBehavior() {
      const errorCode = document.getElementById('errorCode').value;
      const delayMs = document.getElementById('delayMs').value;
      await api('POST', '/api/behavior', { errorCode: Number(errorCode), delayMs: Number(delayMs) });
      location.reload();
    }

    async function resetBehavior() {
      await api('POST', '/api/behavior/reset');
      location.reload();
    }

    async function clearLog() {
      await api('POST', '/api/inbox/clear');
      location.reload();
    }

    // Auto-refresh log every 3s without full page reload
    setInterval(async () => {
      try {
        const [logData, bData] = await Promise.all([
          fetch('/api/inbox').then(r => r.json()),
          fetch('/api/behavior').then(r => r.json()),
        ]);

        // Update status badge
        const badge = document.getElementById('statusBadge');
        badge.className = 'status-indicator status-' + bData.mode;
        let label = bData.mode.toUpperCase();
        if (bData.mode === 'error') label += ' ' + bData.errorCode;
        if (bData.delayMs > 0) label += ' +' + bData.delayMs + 'ms';
        badge.textContent = label;

        // Update log
        const tbody = document.getElementById('logBody');
        if (logData.length === 0) {
          tbody.innerHTML = '<tr><td colspan="7" class="empty">No requests yet.</td></tr>';
          return;
        }
        tbody.innerHTML = logData.map(e => {
          const sc = e.responseStatus === 0 ? 'timeout' : e.responseStatus >= 500 ? '5xx' : e.responseStatus >= 400 ? '4xx' : '2xx';
          const st = e.responseStatus === 0 ? 'TIMEOUT' : e.responseStatus;
          const fn = e.fileName || '–';
          const sz = e.fileSize == null ? '–' : e.fileSize < 1024 ? e.fileSize+' B' : e.fileSize < 1048576 ? (e.fileSize/1024).toFixed(1)+' KB' : (e.fileSize/1048576).toFixed(1)+' MB';
          return '<tr><td>' + new Date(e.time).toLocaleString() + '</td><td><code>' + e.method + ' ' + e.path + '</code></td><td>' + fn + '</td><td>' + sz + '</td><td>' + (e.hasAuth ? '✓' : '–') + '</td><td><span class="status status-' + sc + '">' + st + '</span></td><td class="note">' + (e.note || '') + '</td></tr>';
        }).join('');
      } catch(e) { /* ignore */ }
    }, 3000);
  </script>
</body>
</html>`;
  res.type('html').send(html);
});

// ── Start (local/Docker) ──────────────────────────────────────────────────────
// On Vercel we only export the app; the platform invokes it as a serverless function.
if (!process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Mock HTTP Output server listening on port ${PORT}`);
    console.log(`  Control panel: http://localhost:${PORT}/`);
    console.log(
      '  Upload (from config):',
      uploadRoute.paths.map((p) => uploadRoute.method + ' ' + p).join(', '),
      '-> responds based on current behavior'
    );
    console.log('  GET  /printapi/ping     -> 200 (always)');
    console.log('  GET  /health            -> 200 (always)');
  });
}

// Export the Express app for Vercel serverless; unused when running with listen().
module.exports = app;
