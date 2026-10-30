const EventEmitter = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ─── Persistent Stats Store ───────────────────────────────────────────────────
const STATS_FILE = path.join(__dirname, 'stats.json');
const QUEUE_FILE = path.join(__dirname, 'queue.json');

function loadPersistedStats() {
    try {
        if (fs.existsSync(STATS_FILE)) {
            return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
        }
    } catch (e) {
        console.warn('[Engine] Failed to load persisted stats:', e.message);
    }
    return { accountsCompleted: 0, accountsFailed: 0, totalSubmissions: 0 };
}

function savePersistedStats(stats) {
    try {
        fs.writeFileSync(STATS_FILE, JSON.stringify({
            accountsCompleted: stats.accountsCompleted,
            accountsFailed:    stats.accountsFailed,
            totalSubmissions:  stats.totalSubmissions
        }, null, 2));
    } catch (e) {
        console.warn('[Engine] Failed to persist stats:', e.message);
    }
}

function loadPersistedQueue() {
    try {
        if (fs.existsSync(QUEUE_FILE)) {
            const items = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
            fs.unlinkSync(QUEUE_FILE); // consume once loaded
            return Array.isArray(items) ? items : [];
        }
    } catch (e) {
        console.warn('[Engine] Failed to load persisted queue:', e.message);
    }
    return [];
}

function savePersistedQueue(queue) {
    try {
        if (queue.length > 0) {
            fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
        } else if (fs.existsSync(QUEUE_FILE)) {
            fs.unlinkSync(QUEUE_FILE);
        }
    } catch (e) {
        console.warn('[Engine] Failed to persist queue:', e.message);
    }
}

// ─── Discord Token Validation ─────────────────────────────────────────────────
// Accepts standard Discord tokens (base64.timestamp.hmac) and MFA-prefixed tokens
const DISCORD_TOKEN_REGEX = /^(mfa\.[a-zA-Z0-9_-]{20,}|[a-zA-Z0-9_-]{24,28}\.[a-zA-Z0-9_-]{6}\.[a-zA-Z0-9_-]{27,})$/;

function isValidTokenFormat(token) {
    return typeof token === 'string' && DISCORD_TOKEN_REGEX.test(token.trim());
}

// ─── Discord Headers Builder ──────────────────────────────────────────────────
function getDiscordHeaders(token) {
    return {
        'Authorization': token.trim(),
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9215 Chrome/138.0.7204.251 Electron/37.6.0 Safari/537.36',
        'X-Discord-Locale': 'en-US',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://discord.com/channels/@me'
    };
}

// ─── Admin Webhook Notifier ─────────────────────────────────────────────────
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';

async function sendWebhook(embed) {
    if (!WEBHOOK_URL) return;
    try {
        await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [embed] }),
            signal: AbortSignal.timeout(6000)
        });
    } catch (e) {
        console.warn('[Webhook] Failed to send notification:', e.message);
    }
}

function webhookEmbed({ title, color, fields, footer }) {
    return {
        title,
        color,
        fields: fields.map(f => ({ name: f.name, value: String(f.value), inline: f.inline ?? true })),
        footer: { text: footer || 'QuestSync Cloud' },
        timestamp: new Date().toISOString()
    };
}

// ─── Quest Engine ─────────────────────────────────────────────────────────────
class QuestEngine extends EventEmitter {
    constructor(options = {}) {
        super();
        this.maxSlots       = options.maxSlots || parseInt(process.env.MAX_SLOTS) || 5;
        this.slotCooldownMs = parseInt(process.env.SLOT_COOLDOWN_MS) || 5000;

        this.queue            = [];
        this.slots            = [];
        this.historyLogs      = [];
        this.completedHistory = [];
        this.maxLogs          = parseInt(process.env.MAX_LOG_HISTORY) || 250;

        // For ETA calculation — rolling average of last 10 completion times (seconds)
        this._completionTimes = [];

        this.userSessions = new Map();

        const saved = loadPersistedStats();
        this.stats = {
            activeSlots:       0,
            inQueue:           0,
            accountsCompleted: saved.accountsCompleted,
            accountsFailed:    saved.accountsFailed,
            totalSubmissions:  saved.totalSubmissions,
            successRate:       0,
            avgCompletionSec:  0,
            queueEtaSec:       0
        };

        this.initSlots();

        // Restore queue from previous run if server was restarted mid-queue
        const restoredQueue = loadPersistedQueue();
        if (restoredQueue.length > 0) {
            this.queue = restoredQueue;
            this.stats.inQueue = this.queue.length;
            this.log('SYSTEM', `Restored ${restoredQueue.length} queued account(s) from previous session.`, 'system');
            this.processQueue();
        }
    }

    initSlots() {
        this.slots = [];
        for (let i = 1; i <= this.maxSlots; i++) {
            this.slots.push({
                slotId:          i,
                status:          'IDLE',
                tokenMask:       null,
                account:         null,
                clientId:        null,
                action:          'Standby • Waiting for assignment',
                quests:          [],
                completedQuests: 0,
                totalQuests:     0,
                startedAt:       null,
                elapsed:         0,
                timerRef:        null,
                controller:      null
            });
        }
    }

    maskToken(token) {
        if (!token) return '***';
        const str = token.trim();
        if (str.length <= 10) return str.substring(0, 3) + '***';
        return str.substring(0, 6) + '...' + str.substring(str.length - 4);
    }

    log(slotTag, message, level = 'info', accountTag = '') {
        const now = new Date();

        const logEntry = {
            id:        crypto.randomUUID(),
            // rawTime is an ISO 8601 UTC string — clients re-format it in
            // their own locale/timezone so each user sees their local clock.
            rawTime:   now.toISOString(),
            // legacy fallback: UTC time string (used if a client ignores rawTime)
            timestamp: now.toISOString(),
            slot:      slotTag,
            account:   accountTag,
            message:   message,
            level:     level
        };

        this.historyLogs.unshift(logEntry);
        if (this.historyLogs.length > this.maxLogs) this.historyLogs.pop();

        this.emit('log_event', logEntry);
    }

    /**
     * Validate and enqueue tokens.
     * Only accepts real Discord-format tokens — no demo/sim prefixes.
     */
    enqueueTokens(tokens, clientId = null) {
        if (!tokens || !tokens.length) return 0;

        let added   = 0;
        let skipped = 0;

        tokens.forEach(tok => {
            const clean = tok.trim();
            if (!clean) return;

            if (!isValidTokenFormat(clean)) {
                skipped++;
                this.log('SYSTEM', `Token rejected (invalid format): ${this.maskToken(clean)}`, 'warning');
                return;
            }

            const submissionId = 'sub_' + crypto.randomUUID().replace(/-/g, '').substring(0, 8);
            this.queue.push({
                submissionId,
                clientId:   clientId || 'anon',
                token:      clean,
                enqueuedAt: Date.now()
            });
            added++;
            this.stats.totalSubmissions++;
        });

        if (skipped > 0) {
            this.log('SYSTEM', `${skipped} token(s) skipped — invalid format or not a real Discord token.`, 'warning');
        }

        this.stats.inQueue = this.queue.length;
        this._recalcEta();
        this.log('SYSTEM', `Dispatcher: Enqueued ${added} account(s). Queue depth: ${this.queue.length}`, 'system');
        this.emit('stats_update', this.stats);
        savePersistedStats(this.stats);
        savePersistedQueue(this.queue);
        this.processQueue();
        return added;
    }

    processQueue() {
        if (!this.queue.length) return;
        for (const slot of this.slots) {
            if (slot.status === 'IDLE' && this.queue.length > 0) {
                const nextItem = this.queue.shift();
                this.stats.inQueue = this.queue.length;
                this.stats.activeSlots++;
                this._recalcEta();
                this.emit('stats_update', this.stats);
                savePersistedQueue(this.queue);
                this.runSlot(slot, nextItem);
            }
        }
    }

    // Rolling average completion time + queue ETA
    _recalcEta() {
        const total = this.stats.accountsCompleted + this.stats.accountsFailed;
        this.stats.successRate = total > 0
            ? Math.round((this.stats.accountsCompleted / total) * 100)
            : 0;

        if (this._completionTimes.length > 0) {
            const avg = this._completionTimes.reduce((a, b) => a + b, 0) / this._completionTimes.length;
            this.stats.avgCompletionSec = Math.round(avg);
            const freeSlots = Math.max(1, this.maxSlots - this.stats.activeSlots);
            this.stats.queueEtaSec = Math.round((this.stats.inQueue / freeSlots) * avg);
        } else {
            this.stats.avgCompletionSec = 0;
            this.stats.queueEtaSec     = 0;
        }
    }

    async runSlot(slot, queueItem) {
        const { token, clientId } = queueItem;
        slot.status          = 'STARTING';
        slot.clientId        = clientId;
        slot.tokenMask       = this.maskToken(token);
        slot.startedAt       = Date.now();
        slot.elapsed         = 0;
        slot.completedQuests = 0;
        slot.totalQuests     = 0;
        slot.quests          = [];
        slot.controller      = new AbortController();

        this.log(`Slot ${slot.slotId}`, `Worker #${slot.slotId} initialized. Allocating memory...`, 'info');
        this.emit('slot_update', this.getSlotPublicData(slot));

        // Notify admin — slot started
        sendWebhook(webhookEmbed({
            title: '🚀 Slot Started',
            color: 0x6366f1,
            fields: [
                { name: 'Slot',         value: `#${slot.slotId}` },
                { name: 'Token (masked)', value: `\`${slot.tokenMask}\`` },
                { name: 'Client ID',    value: clientId || 'anon' }
            ],
            footer: 'QuestSync Cloud • Slot Dispatch'
        }));

        slot.timerRef = setInterval(() => {
            if (slot.status !== 'IDLE') {
                slot.elapsed = Math.floor((Date.now() - slot.startedAt) / 1000);
                this.emit('slot_tick', { slotId: slot.slotId, elapsed: slot.elapsed });
            }
        }, 1000);

        try {
            await this.executeRealAccount(slot, token);
        } catch (err) {
            if (err.name === 'AbortError') return; // manually stopped — already handled
            slot.status = 'FAILED';
            slot.action = `Error: ${err.message}`;
            this.stats.accountsFailed++;
            this.log(
                `Slot ${slot.slotId}`,
                `Execution aborted: ${err.message}`,
                'error',
                slot.account?.username ? `@${slot.account.username}` : ''
            );
            this.emit('slot_update', this.getSlotPublicData(slot));
            savePersistedStats(this.stats);

            // Notify admin — slot failed
            sendWebhook(webhookEmbed({
                title: '❌ Slot Failed',
                color: 0xf43f5e,
                fields: [
                    { name: 'Slot',          value: `#${slot.slotId}` },
                    { name: 'Token (masked)', value: `\`${slot.tokenMask || '???'}\`` },
                    { name: 'Account',        value: slot.account ? `@${slot.account.username}` : 'N/A' },
                    { name: 'Error',          value: err.message, inline: false }
                ],
                footer: 'QuestSync Cloud • Failure Report'
            }));
        } finally {
            if (slot.timerRef) {
                clearInterval(slot.timerRef);
                slot.timerRef = null;
            }

            setTimeout(() => {
                if (slot.status === 'IDLE') return; // already manually stopped
                slot.status          = 'IDLE';
                slot.tokenMask       = null;
                slot.account         = null;
                slot.clientId        = null;
                slot.action          = 'Standby • Waiting for assignment';
                slot.quests          = [];
                slot.completedQuests = 0;
                slot.totalQuests     = 0;
                slot.elapsed         = 0;
                this.stats.activeSlots = Math.max(0, this.stats.activeSlots - 1);
                this.emit('stats_update', this.stats);
                this.emit('slot_update', this.getSlotPublicData(slot));
                this.processQueue();
            }, this.slotCooldownMs);
        }
    }

    async executeRealAccount(slot, token) {
        slot.status = 'VALIDATING';
        slot.action = 'Authenticating Discord session...';
        this.log(`Slot ${slot.slotId}`, `Verifying Discord handshake...`, 'info');
        this.emit('slot_update', this.getSlotPublicData(slot));

        const headers = getDiscordHeaders(token);

        // ── Step 1: Authenticate ──────────────────────────────────────────────
        let userRes;
        try {
            userRes = await fetch('https://discord.com/api/v9/users/@me', {
                headers,
                signal: slot.controller.signal
            });
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            throw new Error(`Connection timeout: ${e.message}`);
        }

        if (userRes.status === 401) {
            this.log(`Slot ${slot.slotId}`, `Invalid or expired Discord user token`, 'error');
            throw new Error('401 Unauthorized — Invalid Token');
        }

        if (userRes.status === 429) {
            const retryAfter = userRes.headers.get('retry-after') || '5';
            this.log(`Slot ${slot.slotId}`, `Rate limited. Retry after ${retryAfter}s`, 'warning');
            await this.delay(parseFloat(retryAfter) * 1000 + 500);
            throw new Error(`Rate limited by Discord (retry after ${retryAfter}s)`);
        }

        if (!userRes.ok) {
            throw new Error(`Discord API returned status ${userRes.status}`);
        }

        const userData    = await userRes.json();
        const displayName = userData.global_name || userData.username;
        const discriminator = userData.discriminator || '0';

        slot.account = {
            id:          userData.id,
            username:    userData.username,
            global_name: displayName,
            avatar:      userData.avatar
                ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`
                : `https://cdn.discordapp.com/embed/avatars/${parseInt(discriminator) % 5}.png`,
            tag: `@${userData.username}`
        };

        slot.status = 'AUTHENTICATED';
        slot.action = `Connected as ${displayName}`;
        this.log(`Slot ${slot.slotId}`, `Authenticated: ${displayName} (@${userData.username})`, 'info', `@${userData.username}`);
        this.emit('slot_update', this.getSlotPublicData(slot));

        // Notify admin — account authenticated
        sendWebhook(webhookEmbed({
            title: 'Account Authenticated',
            color: 0x06b6d4,
            fields: [
                { name: 'Slot',          value: `#${slot.slotId}` },
                { name: 'Username',       value: `@${userData.username}` },
                { name: 'Display Name',   value: displayName },
                { name: 'Token (masked)', value: `\`${slot.tokenMask}\`` }
            ],
            footer: 'QuestSync Cloud • Auth Success'
        }));

        await this.delay(1000);

        // ── Step 2: Fetch and combine all quest catalogs ──────────────────────
        slot.status = 'FETCHING';
        slot.action = 'Scanning active & open quest catalogs...';
        this.log(`Slot ${slot.slotId}`, `Scanning Discord quest registry (@me and /open)...`, 'info', `@${userData.username}`);
        this.emit('slot_update', this.getSlotPublicData(slot));

        const questMap = new Map();
        const catalogUrls = [
            'https://discord.com/api/v9/quests/@me',
            'https://discord.com/api/v9/quests/open',
            'https://discord.com/api/v10/quests/open'
        ];

        for (const url of catalogUrls) {
            try {
                const res = await fetch(url, { headers, signal: slot.controller.signal });
                if (res.ok) {
                    const data = await res.json();
                    const list = data.quests || (Array.isArray(data) ? data : []);
                    list.forEach(q => {
                        if (q && q.id && !questMap.has(q.id)) {
                            questMap.set(q.id, q);
                        }
                    });
                }
            } catch (e) {
                if (e.name === 'AbortError') throw e;
            }
        }

        const allQuests = Array.from(questMap.values());
        const now = Date.now();

        const eligibleQuests = allQuests.filter(q => {
            const expires     = new Date(q.config?.expires_at || q.config?.expiresAt || 0).getTime();
            const isExpired   = expires > 0 && expires < now;
            const isCompleted = q.user_status?.completed_at || q.userStatus?.completedAt;
            return !isExpired && !isCompleted;
        });

        this.log(`Slot ${slot.slotId}`, `Catalog scan: ${allQuests.length} found across catalogs, ${eligibleQuests.length} eligible`, 'info', `@${userData.username}`);

        if (eligibleQuests.length === 0) {
            this.log(`Slot ${slot.slotId}`, `All active quests already completed — account is 100% up-to-date!`, 'success', `@${userData.username}`);
            slot.status = 'COMPLETED';
            slot.action = 'Quests up-to-date (100%)';
            this.stats.accountsCompleted++;
            this._recordHistory(slot, userData.username, 0, 0);
            this.emit('stats_update', this.stats);
            savePersistedStats(this.stats);
            return;
        }

        // ── Step 3: Auto-Enroll Unaccepted Quests ──────────────────────────────
        slot.status = 'ENROLLING';
        slot.action = `Enrolling in ${eligibleQuests.length} quests...`;
        this.emit('slot_update', this.getSlotPublicData(slot));

        let newlyEnrolled = 0;
        for (const quest of eligibleQuests) {
            const qName = quest.config?.messages?.quest_name || quest.config?.messages?.questName || quest.name || `Quest #${quest.id}`;
            const isAlreadyEnrolled = !!(quest.user_status?.enrolled_at || quest.userStatus?.enrolledAt);

            if (!isAlreadyEnrolled) {
                try {
                    const enrollPayload = { location: 1 };
                    const sealed = quest.traffic_metadata_sealed || quest.trafficMetadataSealed || quest.metadata_sealed;
                    if (sealed) enrollPayload.traffic_metadata_sealed = sealed;

                    let enrollRes = await fetch(`https://discord.com/api/v9/quests/${quest.id}/enroll`, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(enrollPayload),
                        signal: slot.controller.signal
                    });
                    if (!enrollRes.ok && enrollRes.status !== 401 && enrollRes.status !== 429) {
                        enrollRes = await fetch(`https://discord.com/api/v10/quests/${quest.id}/enroll`, {
                            method: 'POST',
                            headers,
                            body: JSON.stringify(enrollPayload),
                            signal: slot.controller.signal
                        });
                    }
                    if (enrollRes.ok) {
                        newlyEnrolled++;
                        this.log(`Slot ${slot.slotId}`, `Auto-enrolled into quest: "${qName}"`, 'success', `@${userData.username}`);
                    }
                } catch (e) {
                    if (e.name === 'AbortError') throw e;
                }
                await this.delay(350 + Math.random() * 250);
            }
        }

        if (newlyEnrolled > 0) {
            this.log(`Slot ${slot.slotId}`, `Successfully auto-enrolled into ${newlyEnrolled} previously unaccepted quest(s).`, 'success', `@${userData.username}`);
        } else {
            this.log(`Slot ${slot.slotId}`, `All eligible quests verified and ready for task execution.`, 'info', `@${userData.username}`);
        }

        // ── Step 4: Farm ──────────────────────────────────────────────────────
        slot.status          = 'FARMING';
        slot.totalQuests     = eligibleQuests.length;
        slot.completedQuests = 0;
        slot.quests          = eligibleQuests.map((q, idx) => {
            const taskConfig = q.config?.task_config_v2 || q.config?.taskConfigV2 || q.config?.task_config || q.config?.taskConfig || {};
            const tasks = taskConfig.tasks || {};
            const videoKey = Object.keys(tasks).find(k => k.toUpperCase().includes('VIDEO'));
            const isVideo = !!videoKey;
            const taskData = isVideo
                ? tasks[videoKey]
                : (tasks.PLAY_ON_DESKTOP || tasks.STREAM_ON_DESKTOP || Object.values(tasks)[0] || {});
            const appId = taskData.applications?.[0]?.id || q.config?.application?.id || null;
            const targetSec = taskData.target || (isVideo ? 142 : 900);

            // Read existing progress if user already partially completed it
            const userStatus = q.user_status || q.userStatus || {};
            const progressObj = userStatus.progress || {};
            let initialProgress = 0;
            if (isVideo && videoKey && progressObj[videoKey]?.value) {
                initialProgress = progressObj[videoKey].value;
            } else if (progressObj.PLAY_ON_DESKTOP?.value) {
                initialProgress = progressObj.PLAY_ON_DESKTOP.value;
            }

            const qName = q.config?.messages?.quest_name ||
                          q.config?.messages?.questName ||
                          q.config?.messages?.game_title ||
                          q.config?.messages?.gameTitle ||
                          q.name ||
                          `Quest #${idx + 1}`;

            return {
                id:            q.id,
                videoKey:      videoKey || 'WATCH_VIDEO',
                applicationId: appId,
                name:          qName,
                type:          isVideo ? 'VIDEO' : 'GAME',
                progress:      Math.min(targetSec, Math.floor(initialProgress || 0)),
                target:        targetSec,
                completed:     false
            };
        });

        this.log(`Slot ${slot.slotId}`, `Farming ${slot.totalQuests} quests concurrently...`, 'info', `@${userData.username}`);
        this.emit('slot_update', this.getSlotPublicData(slot));

        await this.farmActiveQuests(slot, headers, `@${userData.username}`);
    }

    async claimQuestReward(questId, headers, signal) {
        const endpoints = [
            `https://discord.com/api/v9/quests/${questId}/claim-reward`,
            `https://discord.com/api/v10/quests/${questId}/claim-reward`,
            `https://discord.com/api/v9/quests/${questId}/claim`,
            `https://discord.com/api/v10/quests/${questId}/claim`
        ];
        for (const url of endpoints) {
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ location: 1 }),
                    signal
                });
                if (res.ok) return true;
            } catch (_) {}
        }
        return false;
    }

    async farmActiveQuests(slot, headers, usernameTag) {
        while (slot.completedQuests < slot.totalQuests && slot.status === 'FARMING') {
            await this.delay(18000); // 18-second authentic cadence

            for (const q of slot.quests) {
                if (q.completed) continue;

                if (q.type === 'VIDEO') {
                    const nextTime = Math.min(q.target, Number((q.progress + 15 + Math.random() * 2).toFixed(1)));
                    try {
                        let res = await fetch(`https://discord.com/api/v9/quests/${q.id}/video-progress`, {
                            method: 'POST',
                            headers,
                            body:   JSON.stringify({ timestamp: nextTime }),
                            signal: slot.controller.signal
                        });

                        if (!res.ok && res.status !== 401 && res.status !== 429) {
                            res = await fetch(`https://discord.com/api/v10/quests/${q.id}/video-progress`, {
                                method: 'POST',
                                headers,
                                body:   JSON.stringify({ timestamp: nextTime }),
                                signal: slot.controller.signal
                            });
                        }

                        if (res && res.ok) {
                            let data = {};
                            try { data = await res.json(); } catch (_) {}
                            const userStatus = data.user_status || data.userStatus || data;

                            const progressVal = userStatus.progress?.WATCH_VIDEO?.value ??
                                                userStatus.progress?.WATCH_VIDEO_ON_MOBILE?.value ??
                                                userStatus.progress?.WATCH_VIDEO_DESKTOP?.value ??
                                                (q.videoKey && userStatus.progress?.[q.videoKey]?.value);

                            if (typeof progressVal === 'number' && progressVal > 0) {
                                q.progress = Math.min(q.target, Math.floor(progressVal));
                            } else {
                                q.progress = Math.min(q.target, Math.floor(nextTime));
                            }

                            if (userStatus.completed_at || userStatus.completedAt || q.progress >= q.target) {
                                q.completed = true;
                                q.progress = q.target;
                                slot.completedQuests++;
                                this.log(`Slot ${slot.slotId}`, `Video quest completed: ${q.name}`, 'success', usernameTag);
                                await this.claimQuestReward(q.id, headers, slot.controller.signal);
                            }
                        } else if (res) {
                            const status = res.status;
                            let errBody = '';
                            try { errBody = await res.text(); } catch (_) {}

                            if (status === 400 && (errBody.includes('completed') || errBody.includes('already') || errBody.includes('claimed'))) {
                                q.completed = true;
                                q.progress = q.target;
                                slot.completedQuests++;
                                this.log(`Slot ${slot.slotId}`, `Video quest already completed: ${q.name}`, 'success', usernameTag);
                                await this.claimQuestReward(q.id, headers, slot.controller.signal);
                            } else {
                                q.progress = Math.min(q.target, Math.floor(nextTime));
                                if (q.progress >= q.target) {
                                    q.completed = true;
                                    slot.completedQuests++;
                                    this.log(`Slot ${slot.slotId}`, `Video quest reached target: ${q.name}`, 'success', usernameTag);
                                    await this.claimQuestReward(q.id, headers, slot.controller.signal);
                                } else {
                                    this.log(`Slot ${slot.slotId}`, `Video progress warn (${q.name}): HTTP ${status}`, 'warning', usernameTag);
                                }
                            }
                        }
                    } catch (e) {
                        if (e.name === 'AbortError') throw e;
                        this.log(`Slot ${slot.slotId}`, `Video progress warn (${q.name}): ${e.message}`, 'warning', usernameTag);
                    }
                } else {
                    // Desktop Game Heartbeat
                    try {
                        const heartbeatBody = { terminal: false };
                        if (q.applicationId) heartbeatBody.application_id = q.applicationId;

                        let res = await fetch(`https://discord.com/api/v9/quests/${q.id}/heartbeat`, {
                            method: 'POST',
                            headers,
                            body:   JSON.stringify(heartbeatBody),
                            signal: slot.controller.signal
                        });

                        if (!res.ok && res.status !== 401 && res.status !== 429) {
                            res = await fetch(`https://discord.com/api/v10/quests/${q.id}/heartbeat`, {
                                method: 'POST',
                                headers,
                                body:   JSON.stringify(heartbeatBody),
                                signal: slot.controller.signal
                            });
                        }

                        q.progress = Math.min(q.target, q.progress + 20);

                        if (res && res.ok) {
                            let data = {};
                            try { data = await res.json(); } catch (_) {}
                            const userStatus = data.user_status || data.userStatus || data;
                            const progressVal = userStatus.progress?.PLAY_ON_DESKTOP?.value || q.progress;
                            q.progress = Math.floor(progressVal);

                            if (userStatus.completed_at || userStatus.completedAt || q.progress >= q.target) {
                                q.completed = true;
                                q.progress = q.target;
                                slot.completedQuests++;
                                this.log(`Slot ${slot.slotId}`, `Game quest completed: ${q.name}`, 'success', usernameTag);
                                try {
                                    await fetch(`https://discord.com/api/v9/quests/${q.id}/heartbeat`, {
                                        method: 'POST',
                                        headers,
                                        body: JSON.stringify({ application_id: q.applicationId, terminal: true })
                                    });
                                } catch (_) { /* terminal is non-fatal */ }
                                await this.claimQuestReward(q.id, headers, slot.controller.signal);
                            }
                        } else if (res) {
                            const status = res.status;
                            let errBody = '';
                            try { errBody = await res.text(); } catch (_) {}

                            if (status === 400 && (errBody.includes('completed') || errBody.includes('already') || errBody.includes('claimed'))) {
                                q.completed = true;
                                q.progress = q.target;
                                slot.completedQuests++;
                                this.log(`Slot ${slot.slotId}`, `Game quest already completed: ${q.name}`, 'success', usernameTag);
                                await this.claimQuestReward(q.id, headers, slot.controller.signal);
                            } else if (q.progress >= q.target) {
                                q.completed = true;
                                slot.completedQuests++;
                                this.log(`Slot ${slot.slotId}`, `Game quest reached target: ${q.name}`, 'success', usernameTag);
                                await this.claimQuestReward(q.id, headers, slot.controller.signal);
                            }
                        }
                    } catch (e) {
                        if (e.name === 'AbortError') throw e;
                        this.log(`Slot ${slot.slotId}`, `Heartbeat warn (${q.name}): ${e.message}`, 'warning', usernameTag);
                    }
                }
            }

            slot.action = `Farming ${slot.totalQuests} quests (${slot.completedQuests}/${slot.totalQuests} done)`;
            this.emit('slot_update', this.getSlotPublicData(slot));
        }

        slot.status = 'COMPLETED';
        slot.action = 'Processing completed';
        this.stats.accountsCompleted++;

        // Record elapsed time for rolling ETA average (cap at 10 samples)
        if (slot.elapsed > 0) {
            this._completionTimes.push(slot.elapsed);
            if (this._completionTimes.length > 10) this._completionTimes.shift();
        }
        this._recalcEta();

        this._recordHistory(slot, usernameTag, slot.completedQuests, slot.totalQuests);
        this.log(`Slot ${slot.slotId}`, `Processing completed successfully (${slot.completedQuests}/${slot.totalQuests} quests)`, 'success', usernameTag);
        this.log(`Slot ${slot.slotId}`, `Worker #${slot.slotId} is now idle.`, 'info', usernameTag);
        this.emit('stats_update', this.stats);
        this.emit('slot_update', this.getSlotPublicData(slot));
        savePersistedStats(this.stats);

        // Notify admin — quests completed
        const mins = Math.floor(slot.elapsed / 60);
        const secs = slot.elapsed % 60;
        sendWebhook(webhookEmbed({
            title: 'Quests Completed',
            color: 0x10b981,
            fields: [
                { name: 'Slot',            value: `#${slot.slotId}` },
                { name: 'Account',          value: usernameTag },
                { name: 'Quests Farmed',    value: `${slot.completedQuests}/${slot.totalQuests}` },
                { name: 'Time Elapsed',      value: `${mins}m ${secs}s` },
                { name: 'Total Completed',   value: String(this.stats.accountsCompleted) }
            ],
            footer: 'QuestSync Cloud • Quest Report'
        }));
    }

    // ─── Slot Control ──────────────────────────────────────────────────────────
    stopSlot(slotId) {
        const slot = this.slots.find(s => s.slotId === slotId);
        if (!slot || slot.status === 'IDLE') return;

        if (slot.controller) slot.controller.abort();
        if (slot.timerRef) { clearInterval(slot.timerRef); slot.timerRef = null; }

        slot.status          = 'IDLE';
        slot.tokenMask       = null;
        slot.account         = null;
        slot.clientId        = null;
        slot.action          = 'Standby • Waiting for assignment';
        slot.quests          = [];
        slot.completedQuests = 0;
        slot.totalQuests     = 0;
        slot.elapsed         = 0;
        this.stats.activeSlots = Math.max(0, this.stats.activeSlots - 1);
        this.log(`Slot ${slotId}`, `Worker #${slotId} manually halted by operator.`, 'warning');
        this.emit('stats_update', this.stats);
        this.emit('slot_update', this.getSlotPublicData(slot));
        this.processQueue();
    }

    stopAll() {
        this.queue = [];
        this.stats.inQueue = 0;
        savePersistedQueue(this.queue);
        this.slots.forEach(s => this.stopSlot(s.slotId));
        this.log('SYSTEM', `Dispatcher: All worker threads halted and queue flushed.`, 'warning');
        this.emit('stats_update', this.stats);
    }

    clearQueue() {
        const count = this.queue.length;
        this.queue = [];
        this.stats.inQueue = 0;
        this.log('SYSTEM', `Flushed ${count} queued item(s) from memory.`, 'system');
        this.emit('stats_update', this.stats);
    }

    clearLogs() {
        this.historyLogs = [];
        this.emit('logs_cleared');
    }

    // ─── History Tracking ──────────────────────────────────────────────────────
    _recordHistory(slot, username, completedQuests, totalQuests) {
        this.completedHistory.unshift({
            username,
            completedQuests,
            totalQuests,
            elapsed:    slot.elapsed,
            finishedAt: new Date().toISOString()
        });
        if (this.completedHistory.length > 100) this.completedHistory.pop();
        this.emit('history_update', this.completedHistory.slice(0, 20));
    }

    // ─── Public Data Serializers ───────────────────────────────────────────────
    getSlotPublicData(slot) {
        return {
            slotId:          slot.slotId,
            status:          slot.status,
            tokenMask:       slot.tokenMask,
            account:         slot.account,
            clientId:        slot.clientId,
            action:          slot.action,
            quests:          slot.quests,
            completedQuests: slot.completedQuests,
            totalQuests:     slot.totalQuests,
            elapsed:         slot.elapsed
        };
    }

    getFullState() {
        return {
            maxSlots:          this.maxSlots,
            stats:             this.stats,
            slots:             this.slots.map(s => this.getSlotPublicData(s)),
            queueLength:       this.queue.length,
            recentLogs:        this.historyLogs.slice(0, 70),
            completedHistory:  this.completedHistory.slice(0, 20)
        };
    }

    delay(ms) {
        return new Promise(res => setTimeout(res, ms));
    }
}

module.exports = QuestEngine;
module.exports.isValidTokenFormat = isValidTokenFormat;
