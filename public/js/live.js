/* eslint-env browser */
(function () {
    'use strict';

    const cfg = window.__LIVE__;
    const $ = (id) => document.getElementById(id);
    const grid = $('grid');
    const logList = $('log-list');
    const totalCount = $('total-count');
    const liveCount = $('live-count');
    const disconnectedNum = $('disconnected-num');
    const disconnectedCount = $('disconnected-count');
    const staleNum = $('stale-num');
    const staleCount = $('stale-count');
    const connStatus = $('conn-status');
    const connText = $('conn-text');
    const muteBtn = $('mute-btn');
    const filterButtons = Array.from(document.querySelectorAll('[data-live-filter]'));
    const liveSearchInput = $('live-search-input');
    const liveSearchClear = $('live-search-clear');
    const liveFilterSummary = $('live-filter-summary');

    const cards = new Map(); // pid -> DOMElement
    const connected = new Set(); // pids с активным publisher-сокетом
    const lastTs = new Map(); // pid -> ms
    const stale = new Set(); // pids считаются stale прямо сейчас

    // ---------- Roster (right column) ----------
    const rosterList = $('roster-list');
    const rosterCount = $('roster-count');

    function ensureRosterItem(pid, name) {
        if (!rosterList) return null;
        let li = rosterList.querySelector(`li[data-pid="${pid}"]`);
        if (li) return li;
        const empty = $('roster-empty');
        if (empty) empty.remove();
        li = document.createElement('li');
        li.className = 'roster-item roster-offline';
        li.dataset.pid = String(pid);
        li.dataset.name = name || '';
        li.dataset.frameCount = '0';
        li.dataset.recordingStatus = '';
        li.innerHTML = `
            <a class="roster-link" href="${rosterList.dataset.linkBase || '#'}/${pid}" title="Открыть запись">
                <span class="roster-status-dot" aria-hidden="true"></span>
                <span class="roster-name">${escapeHtml(name || '?')}</span>
                <span class="roster-frames muted" title="Кадров"><i class="fas fa-image"></i> <span class="roster-frame-count">0</span></span>
            </a>
            <span class="roster-meta">
                <span class="roster-rec rec-status"></span>
                <span class="roster-absence muted"></span>
            </span>
        `;
        rosterList.appendChild(li);
        updateRosterCount();
        return li;
    }

    function setRosterStatus(pid, status) {
        if (!rosterList) return;
        const li = rosterList.querySelector(`li[data-pid="${pid}"]`);
        if (!li) return;
        li.classList.remove('roster-online', 'roster-offline', 'roster-stale');
        li.classList.add('roster-' + status);
    }

    function setRosterFrames(pid, count) {
        if (!rosterList) return;
        const li = rosterList.querySelector(`li[data-pid="${pid}"]`);
        if (!li) return;
        li.dataset.frameCount = String(count);
        const cnt = li.querySelector('.roster-frame-count');
        if (cnt) cnt.textContent = String(count);
    }

    function updateRosterCount() {
        if (!rosterCount || !rosterList) return;
        const total = rosterList.querySelectorAll('li[data-pid]').length;
        rosterCount.textContent = `(${total})`;
    }

    // ---------- Toasts ----------
    let toastContainer = document.getElementById('toast-container');
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.id = 'toast-container';
        toastContainer.className = 'toast-container';
        document.body.appendChild(toastContainer);
    }
    function showToast(text, kind) {
        const el = document.createElement('div');
        el.className = 'toast toast-' + (kind || 'info');
        el.textContent = text;
        toastContainer.appendChild(el);
        // Триггерим CSS transition.
        requestAnimationFrame(() => el.classList.add('toast-visible'));
        setTimeout(() => {
            el.classList.remove('toast-visible');
            setTimeout(() => el.remove(), 300);
        }, 3500);
    }

    let muted = false;
    let audioArmed = false;
    let audioCtx = null;
    let beepTimer = null;
    let fullscreenPid = null;
    let currentFilter = 'all';
    let searchQuery = '';

    // ---------- Audio ----------
    function ensureAudio() {
        if (audioCtx) return;
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            audioCtx = new Ctx();
        } catch {
            audioCtx = null;
        }
    }
    function updateAudioButton() {
        if (muted) {
            muteBtn.innerHTML = '<i class="fas fa-bell-slash"></i>';
            muteBtn.title = 'Звук выключен — нажмите чтобы включить';
            muteBtn.classList.remove('btn-success');
            return;
        }
        muteBtn.innerHTML = '<i class="fas fa-bell"></i>';
        muteBtn.title = audioArmed ? 'Звук включён' : 'Нажмите чтобы включить звук';
        muteBtn.classList.toggle('btn-success', audioArmed);
    }
    function armAudio() {
        ensureAudio();
        if (!audioCtx) {
            updateAudioButton();
            return Promise.resolve(false);
        }
        const ready =
            audioCtx.state === 'suspended'
                ? audioCtx.resume().catch(() => null)
                : Promise.resolve();
        return ready.then(() => {
            audioArmed = audioCtx && audioCtx.state === 'running';
            updateAudioButton();
            return audioArmed;
        });
    }
    function beep(freq) {
        if (muted) return;
        armAudio().then((readyToPlay) => {
            if (muted || !audioCtx || !readyToPlay) return;
            const o = audioCtx.createOscillator();
            const g = audioCtx.createGain();
            o.type = 'sine';
            o.frequency.value = freq || 660;
            o.connect(g);
            g.connect(audioCtx.destination);
            const t = audioCtx.currentTime;
            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(0.18, t + 0.02);
            g.gain.setValueAtTime(0.18, t + 0.12);
            g.gain.linearRampToValueAtTime(0, t + 0.18);
            o.start(t);
            o.stop(t + 0.2);
        });
    }
    function playConnectSound() {
        // Два восходящих тона — "подключился"
        beep(660);
        setTimeout(() => beep(880), 150);
    }
    function playDisconnectAlert() {
        beep(440);
        setTimeout(() => beep(330), 180);
    }
    function startBeeping() {
        if (beepTimer) return;
        beep(660);
        beepTimer = setInterval(() => beep(660), 4000);
    }
    function stopBeeping() {
        if (beepTimer) {
            clearInterval(beepTimer);
            beepTimer = null;
        }
    }
    function refreshBeeping() {
        if (stale.size > 0) startBeeping();
        else stopBeeping();
    }

    muteBtn.addEventListener('click', () => {
        if (!audioArmed) {
            muted = false;
            armAudio().then(() => {
                if (stale.size > 0) startBeeping();
            });
            return;
        }
        muted = !muted;
        updateAudioButton();
        if (muted) stopBeeping();
        else if (stale.size > 0) startBeeping();
    });

    // Клик где угодно в гриде — инициализирует AudioContext (требование браузеров).
    grid.addEventListener('click', armAudio, { once: true });
    document.addEventListener('pointerdown', armAudio, { once: true, capture: true });
    document.addEventListener('keydown', armAudio, { once: true, capture: true });
    updateAudioButton();

    // ---------- Log ----------
    const LOG_MAX = 100;

    let logItems = [];

    function formatLogTime(value) {
        const date = value ? new Date(value) : new Date();
        if (Number.isNaN(date.getTime())) return new Date().toLocaleTimeString('ru-RU');
        return date.toLocaleTimeString('ru-RU');
    }

    function connectionLogHtml(event) {
        const name = escapeHtml(event.name || '?');
        const reason =
            event.reasonLabel && event.event === 'disconnect'
                ? ` <span class="muted">(${escapeHtml(event.reasonLabel)})</span>`
                : '';
        if (event.event === 'disconnect') return `Отключился <strong>${name}</strong>${reason}`;
        return `Подключился <strong>${name}</strong>`;
    }

    function connectionLogKind(event) {
        return event.event === 'disconnect' ? 'log-leave' : 'log-join';
    }

    function setLogFromServer(events) {
        logItems = (Array.isArray(events) ? events : []).slice(0, LOG_MAX).map((event) => ({
            time: formatLogTime(event.createdAt),
            html: connectionLogHtml(event),
            kind: connectionLogKind(event),
        }));
        renderLog();
    }

    function renderLog() {
        const emptyLog = $('log-empty');
        if (logItems.length === 0) {
            if (!emptyLog) {
                const li = document.createElement('li');
                li.id = 'log-empty';
                li.className = 'log-empty';
                li.textContent = 'Событий пока нет.';
                logList.innerHTML = '';
                logList.appendChild(li);
            }
            return;
        }
        if (emptyLog) emptyLog.remove();
        logList.innerHTML = '';
        for (const item of logItems) {
            const li = document.createElement('li');
            if (item.kind) li.className = item.kind;
            li.innerHTML = `<span class="log-time">${escapeHtml(item.time)}</span> ${item.html}`;
            logList.appendChild(li);
        }
    }

    function logEvent(html, klass, createdAt) {
        const time = formatLogTime(createdAt);
        logItems.unshift({ time, html, kind: klass || '' });
        if (logItems.length > LOG_MAX) logItems = logItems.slice(0, LOG_MAX);
        renderLog();
    }

    const logClearBtn = $('log-clear');
    if (logClearBtn) {
        logClearBtn.addEventListener('click', () => {
            logItems = [];
            renderLog();
        });
    }

    renderLog();

    // ---------- Cards ----------
    function ensureCard(pid, name) {
        pid = Number(pid);
        let card = cards.get(pid);
        if (card) return card;
        removeEmptyState();
        card = document.createElement('div');
        card.className = 'screen-card';
        card.dataset.pid = String(pid);
        card.dataset.name = name;
        card.innerHTML = `
            <div class="screen-name"><span class="screen-name-text"></span><span class="screen-since muted">—</span></div>
            <div class="screen-img"><span class="screen-placeholder muted">Ожидание кадра…</span></div>
            <div class="screen-status hidden"></div>
        `;
        card.querySelector('.screen-name-text').textContent = name;
        card.addEventListener('click', () => toggleFullscreen(pid));
        grid.appendChild(card);
        cards.set(pid, card);
        return card;
    }
    function ensureCardChrome(card) {
        let nameText = card.querySelector('.screen-name-text');
        if (!nameText) {
            nameText = card.querySelector('.screen-name span:first-child');
            if (nameText) nameText.classList.add('screen-name-text');
        }
        if (!card.querySelector('.screen-status')) {
            const status = document.createElement('div');
            status.className = 'screen-status hidden';
            card.appendChild(status);
        }
    }
    function removeCard(pid) {
        pid = Number(pid);
        const c = cards.get(pid);
        if (c) c.remove();
        cards.delete(pid);
        connected.delete(pid);
        lastTs.delete(pid);
        stale.delete(pid);
        if (fullscreenPid === pid) fullscreenPid = null;
    }
    function removeEmptyState() {
        const currentEmptyState = document.getElementById('empty-state');
        if (currentEmptyState) currentEmptyState.remove();
    }
    function removeFilterEmptyState() {
        const currentFilterEmpty = document.getElementById('filter-empty-state');
        if (currentFilterEmpty) currentFilterEmpty.remove();
    }
    function showEmptyState(text) {
        if (document.getElementById('empty-state') || cards.size > 0) return;
        removeFilterEmptyState();
        const div = document.createElement('div');
        div.className = 'live-empty muted';
        div.id = 'empty-state';
        div.textContent = text;
        grid.appendChild(div);
    }
    function showFilterEmptyState(text) {
        if (document.getElementById('filter-empty-state') || cards.size === 0) return;
        const div = document.createElement('div');
        div.className = 'live-empty muted';
        div.id = 'filter-empty-state';
        div.textContent = text;
        grid.appendChild(div);
    }
    function setCardConnected(pid, isConnected) {
        pid = Number(pid);
        const card = cards.get(pid);
        if (!card) return;
        const status = card.querySelector('.screen-status');
        if (isConnected) {
            connected.add(pid);
            card.classList.remove('stale', 'disconnected');
            stale.delete(pid);
            if (status) {
                status.textContent = '';
                status.classList.add('hidden');
            }
            setCardSince(pid, lastTs.get(pid));
            setRosterStatus(pid, 'online');
        } else {
            connected.delete(pid);
            card.classList.add('stale', 'disconnected');
            stale.add(pid);
            const since = card.querySelector('.screen-since');
            if (since) since.textContent = 'отключился';
            if (status) {
                status.textContent = 'Участник отключился';
                status.classList.remove('hidden');
            }
            setRosterStatus(pid, 'offline');
        }
        refreshProblemCounts();
        refreshBeeping();
        refreshCount();
        applyCardFilter();
    }
    function setCardImage(pid, dataUrl) {
        pid = Number(pid);
        const card = cards.get(pid);
        if (!card) return;
        const slot = card.querySelector('.screen-img');
        let img = slot.querySelector('img');
        if (!img) {
            slot.innerHTML = '';
            img = document.createElement('img');
            slot.appendChild(img);
        }
        img.src = dataUrl;
    }
    function setCardSince(pid, ts) {
        pid = Number(pid);
        const card = cards.get(pid);
        if (!card) return;
        const since = card.querySelector('.screen-since');
        if (!ts) {
            since.textContent = '—';
            return;
        }
        const dt = Date.now() - ts;
        if (dt < 5000) since.textContent = 'только что';
        else if (dt < 60000) since.textContent = Math.round(dt / 1000) + ' сек назад';
        else since.textContent = Math.round(dt / 60000) + ' мин назад';
    }
    function setCardStale(pid, isStale) {
        pid = Number(pid);
        const card = cards.get(pid);
        if (!card) return;
        if (isStale) {
            card.classList.add('stale');
            stale.add(pid);
            const status = card.querySelector('.screen-status');
            if (status && !card.classList.contains('disconnected')) {
                status.textContent = 'Нет новых кадров';
                status.classList.remove('hidden');
            }
            // В roster — stale (warning), но если уже offline — оставляем offline.
            if (rosterList) {
                const li = rosterList.querySelector(`li[data-pid="${pid}"]`);
                if (li && !li.classList.contains('roster-offline')) setRosterStatus(pid, 'stale');
            }
        } else {
            card.classList.remove('stale');
            stale.delete(pid);
            const status = card.querySelector('.screen-status');
            if (status && !card.classList.contains('disconnected')) {
                status.textContent = '';
                status.classList.add('hidden');
            }
            // Если карточка connected — переводим обратно в online.
            if (connected.has(pid)) setRosterStatus(pid, 'online');
        }
        refreshProblemCounts();
        refreshBeeping();
        applyCardFilter();
    }

    function toggleFullscreen(pid) {
        pid = Number(pid);
        const card = cards.get(pid);
        if (!card) return;
        if (fullscreenPid === pid) {
            card.classList.remove('fullscreen');
            fullscreenPid = null;
        } else {
            for (const [otherPid, c] of cards) {
                if (otherPid !== pid) c.classList.remove('fullscreen');
            }
            card.classList.add('fullscreen');
            fullscreenPid = pid;
        }
    }

    function refreshCount() {
        const disconnected = Math.max(0, cards.size - connected.size);
        totalCount.textContent = String(cards.size);
        liveCount.textContent = String(connected.size);
        disconnectedNum.textContent = String(disconnected);
        disconnectedCount.classList.toggle('hidden', disconnected === 0);
    }
    function refreshProblemCounts() {
        staleNum.textContent = String(stale.size);
        staleCount.classList.toggle('hidden', stale.size === 0);
    }
    function isProblemParticipant(pid) {
        return stale.has(pid) || !connected.has(pid);
    }
    function cardMatchesFilter(pid) {
        const card = cards.get(pid);
        const name = String(card ? card.dataset.name : '').toLowerCase();
        if (searchQuery && !name.includes(searchQuery)) return false;
        if (currentFilter === 'active') return connected.has(pid);
        if (currentFilter === 'problem') return isProblemParticipant(pid);
        return true;
    }
    function filterEmptyText() {
        if (searchQuery) return 'По этому поиску участников не найдено.';
        if (currentFilter === 'active') return 'Нет активных участников в этом фильтре.';
        if (currentFilter === 'problem') return 'Проблемных участников сейчас нет.';
        return '';
    }
    function filterLabel() {
        if (currentFilter === 'active') return 'активные';
        if (currentFilter === 'problem') return 'проблемы';
        return 'все';
    }
    function updateFilterSummary(visible) {
        if (!liveFilterSummary) return;
        if (cards.size === 0) {
            liveFilterSummary.textContent = 'Участников пока нет.';
            return;
        }
        const searchSuffix = searchQuery ? `, поиск: «${liveSearchInput.value.trim()}»` : '';
        liveFilterSummary.textContent = `Показано ${visible} из ${cards.size}; фильтр: ${filterLabel()}${searchSuffix}.`;
    }
    function applyCardFilter() {
        removeFilterEmptyState();
        let visible = 0;
        for (const [pid, card] of cards) {
            const show = cardMatchesFilter(pid);
            card.classList.toggle('filtered-hidden', !show);
            if (show) visible++;
        }
        if (cards.size > 0 && visible === 0) {
            showFilterEmptyState(filterEmptyText());
        }
        updateFilterSummary(visible);
    }
    function setLiveFilter(filter) {
        currentFilter = filter;
        filterButtons.forEach((button) => {
            const isActive = button.dataset.liveFilter === filter;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
        applyCardFilter();
    }

    function hydrateInitialCards() {
        grid.querySelectorAll('.screen-card[data-pid]').forEach((card) => {
            const pid = Number(card.dataset.pid);
            if (!Number.isInteger(pid) || pid <= 0) return;
            const name =
                card.dataset.name ||
                card.querySelector('.screen-name span:first-child')?.textContent ||
                '';
            card.dataset.name = name;
            ensureCardChrome(card);
            card.addEventListener('click', () => toggleFullscreen(pid));
            cards.set(pid, card);
            connected.add(pid);
        });
        refreshCount();
        applyCardFilter();
    }

    filterButtons.forEach((button) => {
        button.setAttribute('aria-pressed', button.classList.contains('active') ? 'true' : 'false');
        button.addEventListener('click', () => setLiveFilter(button.dataset.liveFilter || 'all'));
    });

    liveSearchInput.addEventListener('input', () => {
        searchQuery = liveSearchInput.value.trim().toLowerCase();
        liveSearchClear.classList.toggle('hidden', searchQuery.length === 0);
        applyCardFilter();
    });

    liveSearchClear.addEventListener('click', () => {
        liveSearchInput.value = '';
        searchQuery = '';
        liveSearchClear.classList.add('hidden');
        liveSearchInput.focus();
        applyCardFilter();
    });

    // Каждую секунду обновляем "X сек назад".
    setInterval(() => {
        for (const [pid, ts] of lastTs) setCardSince(pid, ts);
    }, 1000);

    hydrateInitialCards();

    // ---------- Socket ----------
    const socket = io('/viewer', {
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        withCredentials: true,
    });

    socket.on('connect', () => {
        connStatus.classList.remove('conn-disconnected', 'conn-warn');
        connStatus.classList.add('conn-connected');
        connText.textContent = 'Подключено';
        socket.emit('subscribe', { examId: cfg.examId }, (resp) => {
            if (!resp || !resp.ok) {
                logEvent('Не удалось подписаться: ' + (resp && resp.reason), 'log-error');
                return;
            }
            setLogFromServer(resp.logEvents);
            // Перерисовать карточки исходя из актуального списка.
            for (const pid of [...cards.keys()]) removeCard(pid);
            connected.clear();
            resp.participants.forEach((p) => {
                const pid = Number(p.id);
                ensureCard(pid, p.name);
                ensureRosterItem(pid, p.name);
                setCardConnected(pid, Boolean(p.online));
                if (p.lastFrameTs) {
                    lastTs.set(pid, Number(p.lastFrameTs));
                    setCardSince(pid, Number(p.lastFrameTs));
                }
            });
            if (cards.size === 0) showEmptyState('Ожидание участников.');
            refreshCount();
            applyCardFilter();
        });
    });
    socket.on('disconnect', () => {
        connStatus.classList.remove('conn-connected', 'conn-warn');
        connStatus.classList.add('conn-disconnected');
        connText.textContent = 'Связь потеряна';
    });
    socket.on('connect_error', (err) => {
        connStatus.classList.remove('conn-connected');
        connStatus.classList.add('conn-warn');
        connText.textContent = 'Ошибка: ' + err.message;
    });

    socket.on('frame', ({ participantId, ts, dataUrl }) => {
        const pid = Number(participantId);
        const card = cards.get(pid);
        if (!card) return; // join придёт чуть позже или мы ещё не подписались
        setCardConnected(pid, true);
        setCardImage(pid, dataUrl);
        lastTs.set(pid, ts);
        setCardSince(pid, ts);
        if (stale.has(pid)) setCardStale(pid, false);
        // Инкрементим счётчик кадров в roster.
        if (rosterList) {
            const li = rosterList.querySelector(`li[data-pid="${pid}"]`);
            if (li) {
                const newCount = Number(li.dataset.frameCount || 0) + 1;
                setRosterFrames(pid, newCount);
            }
        }
    });
    socket.on('participant:join', ({ participantId, name, createdAt }) => {
        const pid = Number(participantId);
        const isNew = !cards.has(pid);
        ensureCard(pid, name);
        ensureRosterItem(pid, name);
        setCardConnected(pid, true);
        refreshCount();
        applyCardFilter();
        if (isNew) {
            logEvent(`Подключился <strong>${escapeHtml(name)}</strong>`, 'log-join', createdAt);
            showToast(`Подключился: ${name}`, 'success');
        } else {
            logEvent(`Переподключился <strong>${escapeHtml(name)}</strong>`, 'log-join', createdAt);
            showToast(`Переподключился: ${name}`, 'info');
        }
        playConnectSound();
    });
    socket.on(
        'participant:leave',
        ({ participantId, name: eventName, reason, reasonLabel, createdAt }) => {
            const pid = Number(participantId);
            const card = cards.get(pid);
            const name = eventName || (card ? card.dataset.name : '?');
            if (card) setCardConnected(pid, false);
            else refreshCount();
            playDisconnectAlert();
            const reasonText =
                reasonLabel || reason
                    ? ` <span class="muted">(${escapeHtml(reasonLabel || reason)})</span>`
                    : '';
            logEvent(
                `Отключился <strong>${escapeHtml(name)}</strong>${reasonText}`,
                'log-leave',
                createdAt
            );
            showToast(`Отключился: ${name}`, 'warn');
        }
    );
    socket.on('participant:stale', ({ participantId, silentMs }) => {
        const pid = Number(participantId);
        if (!cards.has(pid)) return;
        if (!stale.has(pid)) {
            const card = cards.get(pid);
            logEvent(
                `<strong>${escapeHtml(card.dataset.name)}</strong> молчит ${Math.round(silentMs / 1000)} сек`,
                'log-warn'
            );
        }
        setCardStale(pid, true);
    });

    function escapeHtml(s) {
        return String(s).replace(
            /[&<>"']/g,
            (c) =>
                ({
                    '&': '&amp;',
                    '<': '&lt;',
                    '>': '&gt;',
                    '"': '&quot;',
                    "'": '&#39;',
                })[c]
        );
    }
})();
