require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { WebSocketServer } = require('ws');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');
const rateLimit  = require('express-rate-limit');
const helmet     = require('helmet');
const QuestEngine = require('./engine');

const app    = express();
app.set('trust proxy', true);
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

const PORT           = process.env.PORT || 3000;
const TOKENS_FILE    = path.join(__dirname, 'tokens.txt');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

function isAdminAuth(pass) {
    return Boolean(ADMIN_PASSWORD && pass && pass === ADMIN_PASSWORD);
}

function requireAdmin(req, res, next) {
    const pass = req.headers['x-admin-password'] || req.body?.adminPassword;
    if (!isAdminAuth(pass)) {
        return res.status(401).json({ error: 'Unauthorized: Admin authentication required' });
    }
    next();
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc:  ["'self'", "'unsafe-inline'"],
            styleSrc:   ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
            fontSrc:    ["'self'", 'https://fonts.gstatic.com'],
            imgSrc:     ["'self'", 'data:', 'https://cdn.discordapp.com', 'https://api.dicebear.com'],
            connectSrc: ["'self'", 'ws:', 'wss:']
        }
    },
    crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '1mb' }));

// ─── IP-Based Visitor Tracking ────────────────────────────────────────────────
const VISITORS_FILE = path.join(__dirname, 'visitors.json');

function loadLifetimeVisitors() {
    try {
        if (fs.existsSync(VISITORS_FILE)) {
            const arr = JSON.parse(fs.readFileSync(VISITORS_FILE, 'utf8'));
            return new Set(Array.isArray(arr) ? arr : []);
        }
    } catch (e) {
        console.warn('[Visitors] Failed to load visitors.json:', e.message);
    }
    return new Set();
}

const lifetimeVisitors = loadLifetimeVisitors();
const activeIpConnections = new Map();

function saveLifetimeVisitors() {
    try {
        fs.writeFileSync(VISITORS_FILE, JSON.stringify([...lifetimeVisitors]), 'utf8');
    } catch (e) {
        console.warn('[Visitors] Failed to save visitors.json:', e.message);
    }
}

function getClientIp(req) {
    if (!req) return '127.0.0.1';
    const forwarded = req.headers && req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return req.socket?.remoteAddress || req.ip || '127.0.0.1';
}

function hashIp(rawIp) {
    const cleanIp = (rawIp || '').replace(/^::ffff:/, '').trim();
    return crypto.createHash('sha256').update(cleanIp).digest('hex').substring(0, 16);
}

function registerIpVisitor(req) {
    const rawIp = getClientIp(req);
    const ipHash = hashIp(rawIp);
    if (!lifetimeVisitors.has(ipHash)) {
        lifetimeVisitors.add(ipHash);
        saveLifetimeVisitors();
    }
    return ipHash;
}

function getVisitorMetrics() {
    const online = Math.max(1, activeIpConnections.size);
    const total = Math.max(online, lifetimeVisitors.size);
    return { online, total };
}

function broadcastVisitorStats() {
    broadcast('VISITOR_STATS', getVisitorMetrics());
}

app.use((req, res, next) => {
    if (req.path === '/' || req.path === '/index.html') {
        registerIpVisitor(req);
    }
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

const enqueueLimit = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please slow down.' }
});

// ─── Engine ───────────────────────────────────────────────────────────────────
const engine = new QuestEngine({
    maxSlots: parseInt(process.env.MAX_SLOTS) || 5
});

// ─── Broadcast Helper ─────────────────────────────────────────────────────────
function broadcast(type, payload) {
    const data = JSON.stringify({ type, payload });
    wss.clients.forEach(client => {
        if (client.readyState === 1) client.send(data);
    });
}

// ─── Engine Events ────────────────────────────────────────────────────────────
engine.on('log_event',      entry => broadcast('LOG_EVENT',      entry));
engine.on('slot_update',    slot  => broadcast('SLOT_UPDATE',    slot));
engine.on('slot_tick',      tick  => broadcast('SLOT_TICK',      tick));
engine.on('stats_update',   stats => broadcast('STATS_UPDATE',   stats));
engine.on('history_update', hist  => broadcast('HISTORY_UPDATE', hist));
engine.on('logs_cleared',   ()    => broadcast('LOGS_CLEARED',   {}));

// ─── WebSocket Rate Limiting ──────────────────────────────────────────────────
const wsRateMap = new Map();
function isWsRateLimited(clientId) {
    const now   = Date.now();
    const entry = wsRateMap.get(clientId) || { count: 0, resetAt: now + 60000 };
    if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60000; }
    entry.count++;
    wsRateMap.set(clientId, entry);
    return entry.count > 30;
}

// ─── WebSocket Gateway ────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
    const ipHash = registerIpVisitor(req);
    activeIpConnections.set(ipHash, (activeIpConnections.get(ipHash) || 0) + 1);

    const fullState = engine.getFullState();
    fullState.visitorStats = getVisitorMetrics();
    ws.send(JSON.stringify({ type: 'INIT_STATE', payload: fullState }));

    broadcastVisitorStats();

    ws.on('close', () => {
        const remaining = (activeIpConnections.get(ipHash) || 1) - 1;
        if (remaining <= 0) {
            activeIpConnections.delete(ipHash);
        } else {
            activeIpConnections.set(ipHash, remaining);
        }
        broadcastVisitorStats();
    });

    ws.on('error', err => console.error('[WS] Client error:', err.message));

    ws.on('message', message => {
        let data;
        try { data = JSON.parse(message); } catch { return; }

        const clientId = data.clientId || 'anon';

        switch (data.action) {
            case 'ENQUEUE_TOKENS': {
                if (isWsRateLimited(clientId)) {
                    ws.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Rate limited. Slow down.' } }));
                    break;
                }
                const tokens = Array.isArray(data.tokens) ? data.tokens.slice(0, 50) : [];
                engine.enqueueTokens(tokens, clientId);
                break;
            }
            case 'ADMIN_VERIFY': {
                const authorized = isAdminAuth(data.adminPassword);
                ws.send(JSON.stringify({ type: 'ADMIN_AUTH_RESULT', payload: { authorized } }));
                break;
            }
            case 'STOP_SLOT': {
                const slotId = Number(data.slotId);
                const slot = engine.slots.find(s => s.slotId === slotId);
                if (!slot) break;
                // Allow if operator is authenticated as admin OR caller owns this slot
                if (isAdminAuth(data.adminPassword) || (slot.clientId && slot.clientId === clientId)) {
                    engine.stopSlot(slotId);
                } else {
                    ws.send(JSON.stringify({
                        type: 'ERROR',
                        payload: { message: 'Forbidden: You can only halt your own assigned worker' }
                    }));
                }
                break;
            }
            case 'STOP_ALL': {
                if (!isAdminAuth(data.adminPassword)) {
                    ws.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Unauthorized: Admin password required' } }));
                    break;
                }
                engine.stopAll();
                break;
            }
            case 'CLEAR_QUEUE': {
                if (!isAdminAuth(data.adminPassword)) {
                    ws.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Unauthorized: Admin password required' } }));
                    break;
                }
                engine.clearQueue();
                break;
            }
            case 'CLEAR_SERVER_LOGS': {
                if (!isAdminAuth(data.adminPassword)) {
                    ws.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Unauthorized: Admin password required to clear server logs' } }));
                    break;
                }
                engine.clearLogs();
                break;
            }
            default:
                console.warn('[WS] Unknown action:', data.action);
        }
    });
});

// ─── REST API ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({
        status:    'healthy',
        timestamp: new Date().toISOString(),
        uptime:    Math.floor(process.uptime()),
        version:   require('./package.json').version,
        activeSlots: engine.stats.activeSlots,
        maxSlots:    engine.maxSlots,
        queued:      engine.stats.inQueue
    });
});

app.get('/api/state', (req, res) => res.json(engine.getFullState()));

app.post('/api/enqueue', enqueueLimit, (req, res) => {
    const { tokens, clientId } = req.body;
    if (!tokens || !Array.isArray(tokens)) {
        return res.status(400).json({ error: 'tokens array required' });
    }
    const added = engine.enqueueTokens(tokens.slice(0, 50), clientId);
    res.json({ success: true, added, queued: engine.queue.length });
});

app.post('/api/admin/verify', (req, res) => {
    const pass = req.headers['x-admin-password'] || req.body?.adminPassword;
    if (isAdminAuth(pass)) {
        return res.json({ success: true, authorized: true });
    }
    return res.status(401).json({ success: false, error: 'Invalid admin password' });
});

app.post('/api/stop-slot', (req, res) => {
    const slotId = Number(req.body.slotId);
    const pass = req.headers['x-admin-password'] || req.body?.adminPassword;
    const clientId = req.body.clientId;

    const slot = engine.slots.find(s => s.slotId === slotId);
    if (!slot) return res.status(404).json({ error: 'Slot not found' });

    if (isAdminAuth(pass) || (slot.clientId && slot.clientId === clientId)) {
        engine.stopSlot(slotId);
        return res.json({ success: true });
    }
    return res.status(403).json({ error: 'Forbidden: You can only halt your own assigned worker' });
});

app.post('/api/stop-all', requireAdmin, (req, res) => {
    engine.stopAll();
    res.json({ success: true });
});

app.post('/api/clear-queue', requireAdmin, (req, res) => {
    engine.clearQueue();
    res.json({ success: true });
});

app.post('/api/clear-logs', requireAdmin, (req, res) => {
    engine.clearLogs();
    res.json({ success: true });
});

// ─── tokens.txt Management (Admin Authenticated Only) ─────────────────────────
app.get('/api/tokens', requireAdmin, (req, res) => {
    try {
        if (!fs.existsSync(TOKENS_FILE)) return res.json({ raw: '', lines: [], count: 0 });
        const raw   = fs.readFileSync(TOKENS_FILE, 'utf8');
        const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
        res.json({ raw, lines, count: lines.length });
    } catch (err) {
        console.error('[API] Failed to read tokens.txt:', err.message);
        res.status(500).json({ error: 'Failed to read tokens file' });
    }
});

app.post('/api/tokens', requireAdmin, enqueueLimit, (req, res) => {
    try {
        const { tokens } = req.body;
        if (!Array.isArray(tokens)) return res.status(400).json({ error: 'tokens array required' });
        const content = tokens.map(t => t.trim()).filter(Boolean).join('\n');
        fs.writeFileSync(TOKENS_FILE, content, 'utf8');
        res.json({ success: true, saved: tokens.length });
    } catch (err) {
        console.error('[API] Failed to write tokens.txt:', err.message);
        res.status(500).json({ error: 'Failed to write tokens file' });
    }
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
function shutdown(signal) {
    console.log(`\n[Server] ${signal} received — shutting down gracefully...`);
    engine.stopAll();
    server.close(() => { console.log('[Server] Closed.'); process.exit(0); });
    setTimeout(() => process.exit(1), 8000);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
    console.log(`====================================================`);
    console.log(`⚡ QUESTSYNC CLOUD DISPATCHER — PORT ${PORT}`);
    console.log(`🌐 Dashboard:   http://localhost:${PORT}`);
    console.log(`🩺 Healthcheck: http://localhost:${PORT}/health`);
    console.log(`🔧 Max Slots:   ${engine.maxSlots}`);
    console.log(`====================================================`);

    // Keep-alive self-ping for Render free tier (every 5 minutes)
    const selfUrl = process.env.RENDER_EXTERNAL_URL
        ? `${process.env.RENDER_EXTERNAL_URL}/health`
        : null;
    if (selfUrl) {
        setInterval(async () => {
            try { await fetch(selfUrl, { signal: AbortSignal.timeout(8000) }); }
            catch (e) { console.warn('[Keep-Alive] Ping failed:', e.message); }
        }, 5 * 60 * 1000);
        console.log(`💤 Keep-Alive active — pinging every 5 min`);
    }
});

