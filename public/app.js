// ==========================================================================
// QUESTSYNC CLOUD — LIVE DISPATCHER DASHBOARD
// ==========================================================================

(function () {
    'use strict';

    // Unique persistent client identifier
    let localClientId = localStorage.getItem('questsync_client_id');
    if (!localClientId) {
        localClientId = 'client_' + Math.random().toString(36).substring(2, 10);
        localStorage.setItem('questsync_client_id', localClientId);
    }

    // Client State
    const state = {
        ws:                   null,
        reconnectAttempts:    0,
        maxSlots:             5,
        soundEnabled:         true,
        autoScroll:           true,
        activeFilter:         'all',
        stats: {
            activeSlots:       0,
            inQueue:           0,
            accountsCompleted: 0,
            accountsFailed:    0,
            totalSubmissions:  0
        },
        slots:                [],
        logs:                 [],
        myActiveWorkers:      new Map(),
        adminPassword:        sessionStorage.getItem('questsync_admin_pass') || '',
        notificationsEnabled: localStorage.getItem('questsync_notify_enabled') === 'true'
    };

    // DOM Element Cache
    const elements = {
        tokenInput:               document.getElementById('tokenInput'),
        btnStartQuesting:         document.getElementById('btnStartQuesting'),
        btnToggleTokenVisibility: document.getElementById('btnToggleTokenVisibility'),
        btnSoundToggle:           document.getElementById('btnSoundToggle'),
        btnNotifyToggle:          document.getElementById('btnNotifyToggle'),
        btnAdminModal:            document.getElementById('btnAdminModal'),
        btnFooterAdmin:           document.getElementById('btnFooterAdmin'),
        btnOpenBulkModal:         document.getElementById('btnOpenBulkModal'),
        btnOpenTokenGuide:        document.getElementById('btnOpenTokenGuide'),
        btnOpenTokensFileModal:   document.getElementById('btnOpenTokensFileModal'),

        statActiveSlots:          document.getElementById('statActiveSlots'),
        statActiveSlotsPill:      document.getElementById('statActiveSlotsPill'),
        statQueue:                document.getElementById('statQueue'),
        statCompleted:            document.getElementById('statCompleted'),
        statFailed:               document.getElementById('statFailed'),
        statLoaded:               document.getElementById('statLoaded'),
        statSuccessRate:          document.getElementById('statSuccessRate'),
        statQueueEta:             document.getElementById('statQueueEta'),
        statVisitorsOnline:       document.getElementById('statVisitorsOnline'),
        statVisitorsTotal:        document.getElementById('statVisitorsTotal'),
        liveVisitorsCount:        document.getElementById('liveVisitorsCount'),
        totalVisitorsCount:       document.getElementById('totalVisitorsCount'),
        footerVisitorsOnline:     document.getElementById('footerVisitorsOnline'),
        footerVisitorsTotal:      document.getElementById('footerVisitorsTotal'),
        kpiWorkerBar:             document.getElementById('kpiWorkerBar'),

        slotsHeaderSummary:       document.getElementById('slotsHeaderSummary'),
        slotsGrid:                document.getElementById('slotsGrid'),
        consoleTerminal:          document.getElementById('consoleTerminal'),
        logCounter:               document.getElementById('logCounter'),
        btnAutoScroll:            document.getElementById('btnAutoScroll'),
        btnClearLogs:             document.getElementById('btnClearLogs'),
        toastContainer:           document.getElementById('toastContainer'),
        mySessionBody:            document.getElementById('mySessionBody'),
        mySubmissionsCount:       document.getElementById('mySubmissionsCount'),
        historyBody:              document.getElementById('historyBody'),
        historyCount:             document.getElementById('historyCount'),

        bulkModal:                document.getElementById('bulkModal'),
        bulkTokensArea:           document.getElementById('bulkTokensArea'),
        bulkCountPreview:         document.getElementById('bulkCountPreview'),
        btnSubmitBulk:            document.getElementById('btnSubmitBulk'),
        btnLoadFromTokensTxt:     document.getElementById('btnLoadFromTokensTxt'),

        guideModal:               document.getElementById('guideModal'),
        btnCopySnippet:           document.getElementById('btnCopySnippet'),

        tokensFileModal:          document.getElementById('tokensFileModal'),
        tokensFileArea:           document.getElementById('tokensFileArea'),
        btnSaveTokensFile:        document.getElementById('btnSaveTokensFile'),

        adminModal:               document.getElementById('adminModal'),
        adminAuthLock:            document.getElementById('adminAuthLock'),
        adminAuthUnlocked:        document.getElementById('adminAuthUnlocked'),
        adminPasswordInput:       document.getElementById('adminPasswordInput'),
        btnUnlockAdmin:           document.getElementById('btnUnlockAdmin'),
        adminAuthError:           document.getElementById('adminAuthError'),
        btnAdminLogout:           document.getElementById('btnAdminLogout'),
        btnStopAllWorkers:        document.getElementById('btnStopAllWorkers'),
        btnClearPendingQueue:     document.getElementById('btnClearPendingQueue'),
        btnClearServerLogs:       document.getElementById('btnClearServerLogs')
    };

    // Web Audio Chimes
    let audioCtx = null;
    function playChime(type = 'complete') {
        if (!state.soundEnabled) return;
        try {
            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === 'suspended') audioCtx.resume();

            const now  = audioCtx.currentTime;
            const osc  = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.connect(gain);
            gain.connect(audioCtx.destination);

            if (type === 'complete') {
                osc.type = 'sine';
                osc.frequency.setValueAtTime(523.25, now);
                osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.12);
                gain.gain.setValueAtTime(0.05, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
                osc.start(now); osc.stop(now + 0.35);
            } else if (type === 'allDone') {
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(440,    now);
                osc.frequency.setValueAtTime(554.37, now + 0.08);
                osc.frequency.setValueAtTime(659.25, now + 0.16);
                osc.frequency.setValueAtTime(880,    now + 0.24);
                gain.gain.setValueAtTime(0.07, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
                osc.start(now); osc.stop(now + 0.45);
            }
        } catch (_) { /* audio unavailable */ }
    }

    // Native Desktop Push Notifications
    function sendDesktopNotification(title, body, icon) {
        if (!state.notificationsEnabled) return;
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        try {
            const notif = new Notification(title, {
                body,
                icon: icon || 'https://cdn.discordapp.com/embed/avatars/0.png'
            });
            notif.onclick = () => {
                window.focus();
                notif.close();
            };
        } catch (_) {}
    }

    // Utilities
    function formatTime(sec) {
        if (!sec || isNaN(sec)) return '00:00';
        const m = Math.floor(sec / 60).toString().padStart(2, '0');
        const s = (sec % 60).toString().padStart(2, '0');
        return `${m}:${s}`;
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function debounce(fn, ms) {
        let timer;
        return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
    }

    // Worker Fleet Initialization
    function initializeWorkerFleet() {
        elements.slotsGrid.innerHTML = '';
        const userIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`;

        for (let i = 1; i <= state.maxSlots; i++) {
            const card = document.createElement('div');
            card.className = 'worker-card';
            card.id        = `worker-card-${i}`;
            card.innerHTML = `
                <div class="worker-top">
                    <span class="worker-chip">CORE #${i.toString().padStart(2, '0')}</span>
                    <span class="worker-badge idle" id="worker-badge-${i}">STANDBY</span>
                </div>
                <div class="worker-profile">
                    <div class="worker-avatar" id="worker-avatar-${i}">
                        <span class="avatar-placeholder">${userIcon}</span>
                    </div>
                    <div class="worker-profile-info">
                        <div class="worker-name" id="worker-name-${i}">Standby Worker</div>
                        <div class="worker-action" id="worker-action-${i}">Waiting for assignment</div>
                    </div>
                </div>
                <div class="worker-quest-track" id="worker-quests-${i}">
                    <div class="no-tasks">No active tasks in execution</div>
                </div>
                <div class="worker-footer">
                    <span id="worker-timer-${i}">00:00</span>
                    <span id="worker-count-${i}">0/0 quests</span>
                    <button class="worker-btn-stop" data-slot="${i}" title="Halt Core">Halt</button>
                </div>
            `;
            elements.slotsGrid.appendChild(card);
        }

        document.querySelectorAll('.worker-btn-stop').forEach(btn => {
            btn.addEventListener('click', (e) => {
                stopSlot(e.currentTarget.getAttribute('data-slot'));
            });
        });
    }

    // WebSocket Gateway
    function connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        state.ws = new WebSocket(`${protocol}//${window.location.host}`);

        state.ws.onopen = () => {
            state.reconnectAttempts = 0;
            showToast('Connected to cloud dispatcher', 'success');
        };

        state.ws.onmessage = (event) => {
            try { handleServerMessage(JSON.parse(event.data)); }
            catch (err) { console.error('[WS] Parse error:', err); }
        };

        state.ws.onerror = (err) => console.error('[WS] Error:', err);

        state.ws.onclose = () => {
            const delay = Math.min(8000, 800 * Math.pow(1.5, state.reconnectAttempts++));
            showToast(`Connection lost. Reconnecting in ${Math.round(delay / 1000)}s...`, 'error');
            setTimeout(connectWebSocket, delay);
        };
    }

    function sendWs(action, data = {}) {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({ action, clientId: localClientId, ...data }));
        } else {
            showToast('Not connected to server', 'error');
        }
    }

    // Server Message Router
    function handleServerMessage(msg) {
        switch (msg.type) {
            case 'INIT_STATE':     applyFullState(msg.payload);     break;
            case 'LOG_EVENT':      appendLog(msg.payload);          break;
            case 'SLOT_UPDATE':    updateWorkerCard(msg.payload);   break;
            case 'SLOT_TICK':      updateWorkerTick(msg.payload);   break;
            case 'STATS_UPDATE':   updateStats(msg.payload);        break;
            case 'HISTORY_UPDATE': renderHistory(msg.payload);      break;
            case 'VISITOR_STATS':  updateVisitorStats(msg.payload); break;
            case 'LOGS_CLEARED':
                elements.consoleTerminal.innerHTML = '';
                state.logs = [];
                elements.logCounter.textContent = '0 events';
                showToast('Server event logs cleared by operator', 'warning');
                break;
            case 'ERROR':
                showToast(msg.payload?.message || 'Server error', 'error');
                break;
        }
    }

    function applyFullState(payload) {
        state.maxSlots = payload.maxSlots || 5;
        updateStats(payload.stats);
        if (payload.visitorStats) updateVisitorStats(payload.visitorStats);

        if (Array.isArray(payload.slots)) {
            payload.slots.forEach(s => updateWorkerCard(s));
        }

        if (Array.isArray(payload.recentLogs)) {
            elements.consoleTerminal.innerHTML = '';
            state.logs = [];
            payload.recentLogs.slice().reverse().forEach(log => appendLog(log));
        }

        if (Array.isArray(payload.completedHistory)) {
            renderHistory(payload.completedHistory);
        }
    }

    function updateStats(stats) {
        if (!stats) return;
        state.stats = { ...state.stats, ...stats };

        elements.statActiveSlots.textContent = `${state.stats.activeSlots} / ${state.maxSlots}`;
        elements.statQueue.textContent       = state.stats.inQueue;
        elements.statCompleted.textContent   = state.stats.accountsCompleted;
        elements.statFailed.textContent      = state.stats.accountsFailed;
        elements.statLoaded.textContent      = state.stats.totalSubmissions;

        if (elements.statSuccessRate) {
            elements.statSuccessRate.textContent = state.stats.successRate != null
                ? `${state.stats.successRate}%`
                : '—';
        }

        if (elements.statQueueEta) {
            const eta = state.stats.queueEtaSec;
            if (!eta || eta <= 0 || state.stats.inQueue === 0) {
                elements.statQueueEta.textContent = '—';
            } else if (eta < 60) {
                elements.statQueueEta.textContent = `${eta}s`;
            } else {
                const m = Math.floor(eta / 60), s = eta % 60;
                elements.statQueueEta.textContent = `${m}m ${s}s`;
            }
        }

        const pct = Math.min(100, Math.floor((state.stats.activeSlots / state.maxSlots) * 100));
        elements.kpiWorkerBar.style.width = `${pct}%`;

        elements.slotsHeaderSummary.textContent =
            `${state.stats.activeSlots}/${state.maxSlots} Workers Busy (${state.stats.inQueue} Queued)`;
    }

    function updateVisitorStats(stats) {
        if (!stats) return;
        const online = stats.online || 1;
        const total  = stats.total  || online;

        if (elements.liveVisitorsCount)    elements.liveVisitorsCount.textContent    = online;
        if (elements.totalVisitorsCount)   elements.totalVisitorsCount.textContent   = total;
        if (elements.statVisitorsOnline)   elements.statVisitorsOnline.textContent   = online;
        if (elements.statVisitorsTotal)    elements.statVisitorsTotal.textContent    = total;
        if (elements.footerVisitorsOnline) elements.footerVisitorsOnline.textContent = online;
        if (elements.footerVisitorsTotal)  elements.footerVisitorsTotal.textContent  = total;
    }

    function renderHistory(history) {
        if (!elements.historyBody || !elements.historyCount) return;
        if (!history || history.length === 0) {
            elements.historyBody.innerHTML = '<p class="empty-notice">Completed accounts will appear here.</p>';
            elements.historyCount.textContent = '0 done';
            return;
        }
        elements.historyCount.textContent = `${history.length} done`;
        elements.historyBody.innerHTML = '';
        history.forEach(entry => {
            const div = document.createElement('div');
            div.className = 'history-entry';
            const mins = Math.floor((entry.elapsed || 0) / 60);
            const secs = (entry.elapsed || 0) % 60;
            const time = new Date(entry.finishedAt).toLocaleTimeString('en-US', {
                hour: '2-digit', minute: '2-digit', hour12: true
            });
            div.innerHTML = `
                <div class="history-entry-left">
                    <span class="history-user">${escapeHtml(entry.username)}</span>
                    <span class="history-quests">${entry.completedQuests}/${entry.totalQuests} quests</span>
                </div>
                <div class="history-entry-right">
                    <span class="history-time">${time}</span>
                    <span class="history-elapsed">${mins}m ${secs}s</span>
                </div>
            `;
            elements.historyBody.appendChild(div);
        });
    }

    // Worker Card Rendering
    function updateWorkerCard(slot) {
        const id   = slot.slotId;
        const card = document.getElementById(`worker-card-${id}`);
        if (!card) return;

        const badge           = document.getElementById(`worker-badge-${id}`);
        const avatarWrap      = document.getElementById(`worker-avatar-${id}`);
        const nameEl          = document.getElementById(`worker-name-${id}`);
        const actionEl        = document.getElementById(`worker-action-${id}`);
        const questsContainer = document.getElementById(`worker-quests-${id}`);
        const countEl         = document.getElementById(`worker-count-${id}`);
        const timerEl         = document.getElementById(`worker-timer-${id}`);

        card.className = 'worker-card';
        if (['FARMING', 'STARTING', 'VALIDATING', 'AUTHENTICATED', 'ENROLLING', 'FETCHING'].includes(slot.status)) {
            card.classList.add('active');
        } else if (slot.status === 'COMPLETED') {
            card.classList.add('completed');
            playChime('allDone');

            if (slot.clientId === localClientId) {
                const displayName = slot.account ? (slot.account.global_name || slot.account.username) : `Core #${slot.slotId}`;
                sendDesktopNotification(
                    'QuestSync Cloud — Quests Finished',
                    `Account @${displayName} finished farming ${slot.completedQuests}/${slot.totalQuests} quests.`,
                    slot.account?.avatar
                );
            }
        } else if (slot.status === 'FAILED') {
            card.classList.add('failed');
        }

        badge.className   = `worker-badge ${slot.status.toLowerCase()}`;
        badge.textContent = slot.status;

        if (slot.account) {
            const displayName = slot.account.global_name || slot.account.username;
            nameEl.textContent = `${displayName} (${slot.account.tag || '@' + slot.account.username})`;
            avatarWrap.innerHTML = `<img src="${escapeHtml(slot.account.avatar)}" alt="Avatar" loading="lazy"
                onerror="this.src='https://api.dicebear.com/7.x/identicon/svg?seed=${escapeHtml(slot.account.username)}'">`;
        } else {
            nameEl.textContent   = slot.status === 'IDLE' ? 'Standby Worker' : 'Allocating Thread...';
            avatarWrap.innerHTML = '<span class="avatar-placeholder"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg></span>';
        }

        actionEl.textContent = slot.action || 'Waiting for assignment';
        timerEl.textContent  = formatTime(slot.elapsed);
        countEl.textContent  = `${slot.completedQuests || 0}/${slot.totalQuests || 0} quests`;

        if (slot.quests && slot.quests.length > 0) {
            questsContainer.innerHTML = '';
            slot.quests.forEach(q => {
                const pct      = Math.min(100, Math.floor((q.progress / (q.target || 1)) * 100));
                const barClass = q.type === 'VIDEO' ? 'video' : 'game';
                const item     = document.createElement('div');
                item.className = `task-item${q.completed ? ' completed' : ''}`;
                item.innerHTML = `
                    <div class="task-meta">
                        <span class="task-name" title="${escapeHtml(q.name)}">${escapeHtml(q.name)}</span>
                        <span class="task-pct">${q.progress}/${q.target}s (${pct}%)</span>
                    </div>
                    <div class="task-progress-bar-wrap">
                        <div class="task-progress-fill ${barClass}" style="width: ${pct}%"></div>
                    </div>
                `;
                questsContainer.appendChild(item);
            });
        } else {
            questsContainer.innerHTML = '<div class="no-tasks">No active tasks in execution</div>';
        }

        updatePersonalTracker(slot);
    }

    function updateWorkerTick(tick) {
        const timerEl = document.getElementById(`worker-timer-${tick.slotId}`);
        if (timerEl) timerEl.textContent = formatTime(tick.elapsed);
    }

    function updatePersonalTracker(slot) {
        if (slot.clientId !== localClientId) return;

        if (slot.status === 'IDLE' || slot.status === 'COMPLETED' || slot.status === 'FAILED') {
            state.myActiveWorkers.delete(slot.slotId);
        } else {
            state.myActiveWorkers.set(slot.slotId, slot);
        }

        renderPersonalTracker();
    }

    function renderPersonalTracker() {
        const count = state.myActiveWorkers.size;
        elements.mySubmissionsCount.textContent = `${count} Active`;

        if (count === 0) {
            elements.mySessionBody.innerHTML = '<p class="empty-notice">Paste a token above to track account progress here.</p>';
            return;
        }

        elements.mySessionBody.innerHTML = '';
        state.myActiveWorkers.forEach(slot => {
            const entry = document.createElement('div');
            entry.className = 'session-entry';
            const name = slot.account ? (slot.account.global_name || slot.account.username) : `Core #${slot.slotId}`;
            entry.innerHTML = `
                <div class="session-entry-left">
                    <strong>Core #${slot.slotId} &bull; ${escapeHtml(name)}</strong>
                    <div class="session-entry-action">${escapeHtml(slot.action || slot.status)}</div>
                </div>
                <div class="session-entry-right">
                    <span class="session-timer">${formatTime(slot.elapsed)}</span>
                    <div class="session-quests">${slot.completedQuests}/${slot.totalQuests} quests</div>
                </div>
            `;
            elements.mySessionBody.appendChild(entry);
        });
    }

    // Terminal Logging
    function appendLog(log) {
        state.logs.push(log);
        if (state.logs.length > 300) state.logs.shift();
        elements.logCounter.textContent = `${state.logs.length} events`;

        if (log.level === 'success' && log.message.includes('completed')) playChime('complete');
        if (shouldShowLog(log, state.activeFilter)) renderLogRow(log);
    }

    function shouldShowLog(log, filter) {
        if (filter === 'all')     return true;
        if (filter === 'system')  return log.slot === 'SYSTEM' || log.level === 'system';
        if (filter === 'slot')    return log.slot !== 'SYSTEM';
        if (filter === 'success') return log.level === 'success';
        return true;
    }

    function renderLogRow(log) {
        const row     = document.createElement('div');
        row.className = `stream-row ${log.level || 'info'}`;
        const acct    = log.account ? `<span class="row-acct">${escapeHtml(log.account)}:</span>` : '';
        row.innerHTML = `
            <span class="row-ts">[${escapeHtml(log.timestamp)}]</span>
            <span class="row-slot">[${escapeHtml(log.slot)}]</span>
            ${acct}
            <span class="row-msg">${escapeHtml(log.message)}</span>
        `;
        elements.consoleTerminal.appendChild(row);
        if (state.autoScroll) {
            elements.consoleTerminal.scrollTop = elements.consoleTerminal.scrollHeight;
        }
    }

    function rebuildLogView() {
        elements.consoleTerminal.innerHTML = '';
        state.logs.forEach(log => {
            if (shouldShowLog(log, state.activeFilter)) renderLogRow(log);
        });
    }

    // Actions
    function startSingleToken() {
        const token = elements.tokenInput.value.trim();
        if (!token) {
            showToast('Please enter a Discord user token first', 'error');
            elements.tokenInput.focus();
            return;
        }
        sendWs('ENQUEUE_TOKENS', { tokens: [token] });
        showToast('Account dispatched to cloud queue', 'success');
        elements.tokenInput.value = '';
    }

    function stopSlot(slotId) {
        sendWs('STOP_SLOT', { slotId: Number(slotId), adminPassword: state.adminPassword });
        showToast(`Worker Core #${slotId} halt requested`, 'warning');
    }

    function stopAll() {
        if (!state.adminPassword) {
            showToast('Admin password required to stop all workers', 'error');
            return;
        }
        sendWs('STOP_ALL', { adminPassword: state.adminPassword });
        showToast('All active worker threads terminated', 'warning');
    }

    function clearQueue() {
        if (!state.adminPassword) {
            showToast('Admin password required to flush queue', 'error');
            return;
        }
        sendWs('CLEAR_QUEUE', { adminPassword: state.adminPassword });
        showToast('Queue memory cleared', 'success');
    }

    // Admin Deck Controller
    function updateAdminModalView() {
        if (!elements.adminAuthLock || !elements.adminAuthUnlocked) return;
        const isAuthed = Boolean(state.adminPassword);
        elements.adminAuthLock.style.display = isAuthed ? 'none' : 'block';
        elements.adminAuthUnlocked.style.display = isAuthed ? 'block' : 'none';
        if (elements.adminAuthError) elements.adminAuthError.style.display = 'none';
        if (!isAuthed && elements.adminPasswordInput) elements.adminPasswordInput.value = '';
    }

    async function verifyAdminPassword(pass) {
        if (!pass) return false;
        try {
            const res = await fetch('/api/admin/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminPassword: pass })
            });
            const data = await res.json();
            return Boolean(data.success && data.authorized);
        } catch (_) { return false; }
    }

    async function handleAdminUnlock() {
        const pass = elements.adminPasswordInput.value.trim();
        if (!pass) return;
        const ok = await verifyAdminPassword(pass);
        if (ok) {
            state.adminPassword = pass;
            sessionStorage.setItem('questsync_admin_pass', pass);
            updateAdminModalView();
            showToast('Operator console unlocked', 'success');
        } else {
            if (elements.adminAuthError) elements.adminAuthError.style.display = 'block';
            showToast('Invalid admin password', 'error');
        }
    }

    // Toast Notifications
    function showToast(message, type = 'info') {
        const existing = elements.toastContainer.querySelectorAll('.toast');
        if (existing.length >= 5) existing[0].remove();

        const toast     = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        elements.toastContainer.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity   = '0';
            toast.style.transform = 'translateY(8px)';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // Modals
    function openModal(modal)  { modal.classList.add('open'); }
    function closeModal(modal) { modal.classList.remove('open'); }

    // API Helpers
    async function fetchTokensTxt() {
        try {
            const headers = {};
            if (state.adminPassword) headers['x-admin-password'] = state.adminPassword;
            const res  = await fetch('/api/tokens', { headers });
            if (res.status === 401) {
                showToast('Admin password required to load server tokens.txt', 'error');
                return '';
            }
            const data = await res.json();
            return data.raw || '';
        } catch (_) { return ''; }
    }

    async function saveTokensTxt(lines) {
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (state.adminPassword) headers['x-admin-password'] = state.adminPassword;
            const res  = await fetch('/api/tokens', {
                method:  'POST',
                headers,
                body:    JSON.stringify({ tokens: lines })
            });
            if (res.status === 401) {
                showToast('Admin password required to modify server tokens.txt', 'error');
                return false;
            }
            const data = await res.json();
            return Boolean(data.success);
        } catch (_) { return false; }
    }

    // Event Listeners
    function setupListeners() {
        elements.btnStartQuesting.addEventListener('click', startSingleToken);
        elements.tokenInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') startSingleToken();
        });

        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                startSingleToken();
            }
        });

        // Token Visibility Toggle
        elements.btnToggleTokenVisibility.addEventListener('click', () => {
            const isPass = elements.tokenInput.type === 'password';
            elements.tokenInput.type = isPass ? 'text' : 'password';
            elements.btnToggleTokenVisibility.classList.toggle('active', isPass);
        });

        // Audio Toggle
        elements.btnSoundToggle.addEventListener('click', () => {
            state.soundEnabled = !state.soundEnabled;
            elements.btnSoundToggle.classList.toggle('muted', !state.soundEnabled);
            showToast(state.soundEnabled ? 'Audio alerts unmuted' : 'Audio alerts muted');
        });

        // Desktop Push Notifications Toggle
        if (elements.btnNotifyToggle) {
            elements.btnNotifyToggle.classList.toggle('active', state.notificationsEnabled && Notification.permission === 'granted');

            elements.btnNotifyToggle.addEventListener('click', async () => {
                if (!('Notification' in window)) {
                    showToast('Notifications are not supported in your browser', 'error');
                    return;
                }
                if (Notification.permission === 'denied') {
                    showToast('Notifications are blocked in your browser settings', 'error');
                    return;
                }
                if (Notification.permission !== 'granted') {
                    const result = await Notification.requestPermission();
                    if (result !== 'granted') {
                        showToast('Notification permission denied', 'error');
                        return;
                    }
                }
                state.notificationsEnabled = !state.notificationsEnabled;
                localStorage.setItem('questsync_notify_enabled', String(state.notificationsEnabled));
                elements.btnNotifyToggle.classList.toggle('active', state.notificationsEnabled);
                showToast(state.notificationsEnabled ? 'Desktop notifications enabled' : 'Desktop notifications muted');
                if (state.notificationsEnabled) {
                    sendDesktopNotification('QuestSync Cloud', 'Desktop push notifications active. You will be alerted when accounts finish.');
                }
            });
        }

        // Auto-Scroll Lock
        elements.btnAutoScroll.addEventListener('click', () => {
            state.autoScroll = !state.autoScroll;
            elements.btnAutoScroll.classList.toggle('active', state.autoScroll);
        });

        // Clear Logs
        elements.btnClearLogs.addEventListener('click', () => {
            if (state.adminPassword) {
                const purgeAll = confirm('Clear server log history for all connected users? Cancel to clear only your screen.');
                if (purgeAll) {
                    sendWs('CLEAR_SERVER_LOGS', { adminPassword: state.adminPassword });
                    return;
                }
            }
            elements.consoleTerminal.innerHTML = '';
            state.logs = [];
            elements.logCounter.textContent = '0 events';
            showToast('Local terminal view cleared');
        });

        // Filter Strip
        document.querySelectorAll('.filter-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                state.activeFilter = e.target.getAttribute('data-filter');
                rebuildLogView();
            });
        });

        // Modals
        elements.btnOpenBulkModal.addEventListener('click', () => openModal(elements.bulkModal));
        elements.btnOpenTokenGuide.addEventListener('click', () => openModal(elements.guideModal));
        elements.btnOpenTokensFileModal.addEventListener('click', async () => {
            elements.tokensFileArea.value = await fetchTokensTxt();
            openModal(elements.tokensFileModal);
        });
        elements.btnAdminModal.addEventListener('click', () => {
            updateAdminModalView();
            openModal(elements.adminModal);
        });
        elements.btnFooterAdmin.addEventListener('click', () => {
            updateAdminModalView();
            openModal(elements.adminModal);
        });

        // Admin Unlock & Logout
        elements.btnUnlockAdmin.addEventListener('click', handleAdminUnlock);
        elements.adminPasswordInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') handleAdminUnlock();
        });
        elements.btnAdminLogout.addEventListener('click', () => {
            state.adminPassword = '';
            sessionStorage.removeItem('questsync_admin_pass');
            updateAdminModalView();
            showToast('Operator console locked');
        });

        document.querySelectorAll('[data-close]').forEach(btn => {
            btn.addEventListener('click', () => {
                const target = document.getElementById(btn.getAttribute('data-close'));
                if (target) closeModal(target);
            });
        });

        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) closeModal(overlay);
            });
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal-overlay.open').forEach(m => closeModal(m));
            }
        });

        // Bulk Import
        const updateBulkPreview = debounce(() => {
            const lines = elements.bulkTokensArea.value.split('\n').map(l => l.trim()).filter(Boolean);
            elements.bulkCountPreview.textContent = `${lines.length} accounts parsed`;
        }, 200);

        elements.bulkTokensArea.addEventListener('input', updateBulkPreview);

        elements.btnLoadFromTokensTxt.addEventListener('click', async () => {
            const raw = await fetchTokensTxt();
            elements.bulkTokensArea.value = raw;
            updateBulkPreview();
        });

        elements.btnSubmitBulk.addEventListener('click', () => {
            const lines = elements.bulkTokensArea.value.split('\n').map(l => l.trim()).filter(Boolean);
            if (!lines.length) { showToast('No accounts detected in input', 'error'); return; }
            sendWs('ENQUEUE_TOKENS', { tokens: lines });
            showToast(`Enqueued ${lines.length} accounts to queue`, 'success');
            elements.bulkTokensArea.value = '';
            elements.bulkCountPreview.textContent = '0 accounts parsed';
            closeModal(elements.bulkModal);
        });

        // Token Extraction Snippet Copy
        elements.btnCopySnippet.addEventListener('click', () => {
            const code = `(webpackChunkdiscord_app.push([[''],{},e=>{m=[];for(let c in e.c)m.push(e.c[c])}]),m).find(m=>m?.exports?.default?.getToken!==void 0).exports.default.getToken()`;
            navigator.clipboard.writeText(code)
                .then(() => showToast('Extraction script copied', 'success'))
                .catch(() => showToast('Clipboard write failed', 'error'));
        });

        // Admin Dangerous Actions
        elements.btnStopAllWorkers.addEventListener('click', () => {
            stopAll();
            closeModal(elements.adminModal);
        });

        elements.btnClearPendingQueue.addEventListener('click', () => {
            clearQueue();
            closeModal(elements.adminModal);
        });

        if (elements.btnClearServerLogs) {
            elements.btnClearServerLogs.addEventListener('click', () => {
                if (!state.adminPassword) {
                    showToast('Admin password required', 'error');
                    return;
                }
                if (confirm('Permanently purge all event history logs on the server?')) {
                    sendWs('CLEAR_SERVER_LOGS', { adminPassword: state.adminPassword });
                    closeModal(elements.adminModal);
                }
            });
        }
    }

    // Bootstrap
    function init() {
        initializeWorkerFleet();
        setupListeners();
        connectWebSocket();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
