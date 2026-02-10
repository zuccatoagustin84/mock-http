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

## Run locally

From the repo root. Pick one of these:

| Method | Command | URL |
|--------|---------|-----|
| **Node** | `npm install && npm start` | http://localhost:3000 |
| **Docker** | `docker build -t mock-http . && docker run -p 21203:3000 -e PORT=3000 mock-http` | http://localhost:21203 |
| **Docker Compose** | `docker compose up -d` | http://localhost:21203 |
| **Vercel (local)** | `npx vercel dev` | per Vercel CLI |

### 1. Node (no Docker)

```bash
npm install
npm start
```

Server: **http://localhost:3000**

### 2. Docker (single container)

```bash
docker build -t mock-http .
docker run -p 21203:3000 -e PORT=3000 mock-http
```

Server: **http://localhost:21203**

### 3. Docker Compose

```bash
docker compose up -d
```

Server: **http://localhost:21203**. Same image as Render. Use `docker compose up` to see logs in the terminal.

### 4. Vercel (local serverless)

```bash
npm install
npx vercel dev
```

Runs the app in Vercel’s local serverless mode (good for testing the Vercel deploy path).

---

### Worker configuration (local)

- **baseUrl:** `http://localhost:3000` (Node) or `http://localhost:21203` (Docker / Compose)
- **uploadPath:** `upload`
- **pingPath:** `printapi/ping`
- (optional: **apiToken** for Basic auth)

Toggle chaos from the control panel at the URL above.

## Deploy on Vercel

The app is compatible with Vercel: it exports the Express app and only calls `listen()` when not running on Vercel (`VERCEL` env is unset).

- Connect the repo in [Vercel](https://vercel.com); Vercel will detect `server.js` and use it as the serverless entry.
- Ensure `config.json` is in the repo so upload routes are loaded.
- For local dev with Vercel CLI: `vercel dev`.

## Deploy on Render

On Render, `VERCEL` is not set, so the server runs with `app.listen(PORT)`; Render sets `PORT` automatically.

- **Blueprint (recommended):** Dashboard → **New** → **Blueprint** → connect this repo.
  - **Docker:** use default `render.yaml` (builds from `Dockerfile`).
  - **Node native:** set Blueprint path to `render-node.yaml`.
- **Manual:** **New** → **Web Service** → connect repo → Build: `npm install`, Start: `npm start`, Health path: `/health`.
- Free plan is enough; URL: `https://<service-name>.onrender.com`.
