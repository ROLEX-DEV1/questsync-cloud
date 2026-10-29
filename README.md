# ⚡ QuestSync Cloud — Automated Multi-Account Task Orchestrator
### Powered by [discord.gg/kohinoor](https://discord.gg/kohinoor)

An enterprise-grade, multi-tenant Discord Quest automation and cloud concurrency engine. Designed from the ground up for high-throughput parallel task execution, zero-trace token security, and real-time operations telemetry.

---

## 💎 Features

* **5-Core High-Efficiency Fleet:** Orchestrates up to 5 parallel account workers simultaneously with real-time status telemetry, progress tracks, and elapsed counters.
* **Official Community Integration:** Direct connection and support via [discord.gg/kohinoor](https://discord.gg/kohinoor).
* **Dual Execution Engine:**
  * **Live Discord API Mode:** Utilizes authentic Discord client headers, `X-Super-Properties`, Chromium build simulation, and randomized human jitter.
  * **Sandbox Simulation Mode:** Safe local testing suite allowing instant dry-run simulations with zero account risk.
* **Supported Quest Types:**
  * Video Streaming (`WATCH_VIDEO`, `WATCH_VIDEO_ON_MOBILE`) with sub-second randomized heartbeat jitter.
  * Desktop Gaming (`PLAY_ON_DESKTOP`) background heartbeats.
  * Voice Activity (`PLAY_ACTIVITY`) session progression.
* **Real-time Operations Cockpit:** Split-view operations console with live event stream, search filters, audio chimes, and session inspection.
* **Privacy & Security:** Zero-trace in-memory token execution pipeline. Tokens are never exposed publicly across user sessions.

---

## 🚀 Quick Start (Local)

1. **Install Dependencies:**
   ```bash
   npm install
   ```

2. **Launch Application:**
   ```bash
   npm start
   ```

3. **Open Dashboard:**
   Navigate to [http://localhost:3000](http://localhost:3000).

---

## 🌐 Public Cloud Deployment Guide

QuestSync Cloud is ready to deploy to any cloud provider:

### Option 1: Render.com
1. Create a **New Web Service** on Render and connect your GitHub repository.
2. Select **Node** as the environment:
   * **Build Command:** `npm install`
   * **Start Command:** `npm start`
3. Set your healthcheck path to `/health`.
4. Render automatically binds the assigned `PORT` environment variable.

### Option 2: Railway.app
1. Click **New Project** → **Deploy from GitHub repo**.
2. Railway will automatically detect the `Dockerfile` or `package.json` and deploy.

### Option 3: Docker / VPS
```bash
# Build the production Docker image
docker build -t questsync-cloud .

# Run the container (maps to port 3000)
docker run -d -p 3000:3000 --name questsync questsync-cloud
```

### Option 4: PM2 on Ubuntu/Debian VPS
```bash
npm install -g pm2
pm2 start server.js --name "questsync"
pm2 startup
pm2 save
```

---

## 🔑 Token Extraction Method

1. Open Discord in your browser at [discord.com/app](https://discord.com/app).
2. Press <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>I</kbd> (or <kbd>Cmd</kbd> + <kbd>Option</kbd> + <kbd>I</kbd> on Mac) and select the **Console** tab.
3. Paste the following script and hit Enter:
   ```javascript
   (webpackChunkdiscord_app.push([[''],{},e=>{m=[];for(let c in e.c)m.push(e.c[c])}]),m).find(m=>m?.exports?.default?.getToken!==void 0).exports.default.getToken()
   ```
4. Copy the output and paste it into the **QuestSync Cloud Dispatch Terminal**.

---

## 🛠️ API & Healthcheck Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/health` | `GET` | Container & uptime healthcheck (`status: healthy`, active slots, queue count) |
| `/api/state` | `GET` | Snapshot of the current engine state and worker slots |
| `/api/enqueue` | `POST` | Enqueue an array of tokens for execution |
| `/api/demo` | `POST` | Trigger a 12-core sandbox simulation run |
| `/api/stop-all` | `POST` | Halt all active workers |

---

## ⚖️ License & Disclaimer

Built for multi-account concurrency orchestration and task automation. Automating Discord user accounts violates Discord's Terms of Service. Use the sandbox simulation mode for demonstrations or exercise appropriate caution with personal accounts.
