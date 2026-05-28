/* eslint-env browser */
(function () {
    'use strict';

    const cfg = window.__LIVE__;
    const $ = (id) => document.getElementById(id);
    const grid = $('grid');
    const logList = $('log-list');
    const liveCount = $('live-count');
    const staleNum = $('stale-num');
    const staleCount = $('stale-count');
    const connStatus = $('conn-status');
    const connText = $('conn-text');
    const muteBtn = $('mute-btn');

    const cards = new Map(); // pid -> DOMElement
    const connected = new Set(); // pids с активным publisher-сокетом
    const lastTs = new Map(); // pid -> ms
    const stale = new Set(); // pids считаются stale прямо сейчас

    let muted = false;
    let audioCtx = null;
    let beepTimer = null;
    let fullscreenPid = null;

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
    function beep(freq) {
        if (muted) return;
        ensureAudio();
        if (!audioCtx) return;
        const ready =
            audioCtx.state === 'suspended' ? audioCtx.resume().catch(() => {}) : Promise.resolve();
        ready.then(() => {
            if (muted || !audioCtx) return;
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
        ensureAudio();
        muted = !muted;
        muteBtn.textContent = muted ? 'Звук выключен' : 'Звук включен';
        if (muted) stopBeeping();
        else if (stale.size > 0) startBeeping();
    });

    // Клик где угодно в гриде — инициализирует AudioContext (требование браузеров).
    grid.addEventListener('click', ensureAudio, { once: true });
    document.addEventListener('pointerdown', ensureAudio, { once: true, capture: true });
    document.addEventListener('keydown', ensureAudio, { once: true, capture: true });

    // ---------- Log ----------
    function logEvent(html, klass) {
        const li = document.createElement('li');
        li.className = klass || '';
        li.innerHTML = `<span class="log-time">${new Date().toLocaleTimeString('ru-RU')}</span> ${html}`;
        logList.prepend(li);
        if (logList.children.length > 100) logList.lastChild.remove();
    }

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
        `;
        card.querySelector('.screen-name-text').textContent = name;
        card.addEventListener('click', () => toggleFullscreen(pid));
        grid.appendChild(card);
        cards.set(pid, card);
        return card;
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
    function showEmptyState(text) {
        if (document.getElementById('empty-state') || cards.size > 0) return;
        const div = document.createElement('div');
        div.className = 'live-empty muted';
        div.id = 'empty-state';
        div.textContent = text;
        grid.appendChild(div);
    }
    function setCardConnected(pid, isConnected) {
        pid = Number(pid);
        const card = cards.get(pid);
        if (!card) return;
        if (isConnected) {
            connected.add(pid);
            card.classList.remove('stale');
            stale.delete(pid);
            setCardSince(pid, lastTs.get(pid));
        } else {
            connected.delete(pid);
            card.classList.add('stale');
            stale.add(pid);
            const since = card.querySelector('.screen-since');
            if (since) since.textContent = 'отключился';
        }
        staleNum.textContent = String(stale.size);
        staleCount.classList.toggle('hidden', stale.size === 0);
        refreshBeeping();
        refreshCount();
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
        } else {
            card.classList.remove('stale');
            stale.delete(pid);
        }
        staleNum.textContent = String(stale.size);
        staleCount.classList.toggle('hidden', stale.size === 0);
        refreshBeeping();
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
        liveCount.textContent = String(connected.size);
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
            card.addEventListener('click', () => toggleFullscreen(pid));
            cards.set(pid, card);
            connected.add(pid);
        });
        refreshCount();
    }

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
            // Перерисовать карточки исходя из актуального списка.
            for (const pid of [...cards.keys()]) removeCard(pid);
            connected.clear();
            resp.participants.forEach((p) => {
                const pid = Number(p.id);
                ensureCard(pid, p.name);
                setCardConnected(pid, true);
                if (p.lastFrameTs) {
                    lastTs.set(pid, Number(p.lastFrameTs));
                    setCardSince(pid, Number(p.lastFrameTs));
                }
            });
            if (cards.size === 0) showEmptyState('Ожидание участников.');
            refreshCount();
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
    });
    socket.on('participant:join', ({ participantId, name }) => {
        const pid = Number(participantId);
        ensureCard(pid, name);
        setCardConnected(pid, true);
        refreshCount();
        logEvent(`Подключился <strong>${escapeHtml(name)}</strong>`, 'log-join');
    });
    socket.on('participant:leave', ({ participantId }) => {
        const pid = Number(participantId);
        const card = cards.get(pid);
        const name = card ? card.dataset.name : '?';
        if (card) setCardConnected(pid, false);
        else refreshCount();
        playDisconnectAlert();
        logEvent(`Отключился <strong>${escapeHtml(name)}</strong>`, 'log-leave');
    });
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
