# Mock HTTP Output API

Mock server with **runtime chaos control** (MailHog-style) for the HTTP Output API used by the comm worker.

## How it works

All uploads go to the **same endpoint** (`POST /upload` or `POST /`).
The response depends on the current **behavior** configured via the UI panel — no need to change URLs.

Open **http://localhost:21203** to see the **Control Panel**:

- **Normal** — responds 200 OK (default)
- **Error** — responds with a configurable error code (400, 401, 500, 503, etc.)
- **Timeout** — hangs forever (simulates network timeout, the request never gets a response)
- **Delay** — adds latency (ms) before responding, works in any mode

Switch between modes with one click. The log shows every received request with status and chaos note.

## API

### Upload (affected by chaos)

- `POST /upload` or `POST /` — multipart/form-data, field name `pdf`
- Optional Basic auth (API token as username, password empty)

### Control (manage chaos at runtime)

| Endpoint | Description |
|---|---|
| `GET /` | Control panel + inbox UI |
| `GET /api/behavior` | Current behavior (JSON) |
| `POST /api/behavior` | Set behavior: `{ "mode": "error", "errorCode": 500, "delayMs": 2000 }` |
| `POST /api/behavior/reset` | Reset to defaults (normal, no delay) |
| `GET /api/inbox` | Request log (JSON) |
| `POST /api/inbox/clear` | Clear log |

### Always healthy (not affected by chaos)

| Endpoint | Description |
|---|---|
| `GET /printapi/ping` | Ping (200 always) |
| `GET /health` | Health check (200 always) |

## Run with Docker Compose

```bash
cd development/mock-http-output
docker compose up -d
```

Server: **http://localhost:21203**

### Worker configuration

- `baseUrl`: `http://localhost:21203`
- `uploadPath`: `upload`
- `pingPath`: `printapi/ping`
- (optional: `apiToken` for Basic auth)

Then toggle chaos from the panel at http://localhost:21203 whenever you want to simulate failures.

## Run locally (no Docker)

```bash
cd development/mock-http-output
npm install
npm start
```

## Deploy on Vercel

The app is compatible with Vercel: it exports the Express app and only calls `listen()` when not running on Vercel (`VERCEL` env is unset).

- Connect the repo in [Vercel](https://vercel.com); Vercel will detect `server.js` and use it as the serverless entry.
- Ensure `config.json` is in the repo so upload routes are loaded.
- For local dev with Vercel CLI: `vercel dev`.
