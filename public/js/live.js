/* eslint-env browser */
(function () {
    'use strict';

    const cfg = window.__LIVE__;
    const $ = (id) => document.getElementById(id);
    const grid = $('grid');
    const emptyState = $('empty-state');
    const logList = $('log-list');
    const liveCount = $('live-count');
    const staleNum = $('stale-num');
    const staleCount = $('stale-count');
    const connStatus = $('conn-status');
    const connText = $('conn-text');
    const muteBtn = $('mute-btn');

    const cards = new Map(); // pid -> DOMElement
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
        if (muted || !audioCtx) return;
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
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
        let card = cards.get(pid);
        if (card) return card;
        if (emptyState) emptyState.remove();
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
        const c = cards.get(pid);
        if (c) c.remove();
        cards.delete(pid);
        lastTs.delete(pid);
        stale.delete(pid);
        if (fullscreenPid === pid) fullscreenPid = null;
    }
    function setCardImage(pid, dataUrl) {
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
        liveCount.textContent = String(cards.size);
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
            resp.participants.forEach((p) => {
                ensureCard(p.id, p.name);
                if (p.lastFrameTs) {
                    lastTs.set(p.id, Number(p.lastFrameTs));
                    setCardSince(p.id, Number(p.lastFrameTs));
                }
            });
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
        const card = cards.get(participantId);
        if (!card) return; // join придёт чуть позже или мы ещё не подписались
        setCardImage(participantId, dataUrl);
        lastTs.set(participantId, ts);
        setCardSince(participantId, ts);
        if (stale.has(participantId)) setCardStale(participantId, false);
    });
    socket.on('participant:join', ({ participantId, name }) => {
        ensureCard(participantId, name);
        refreshCount();
        logEvent(`Подключился <strong>${escapeHtml(name)}</strong>`, 'log-join');
    });
    socket.on('participant:leave', ({ participantId }) => {
        const card = cards.get(participantId);
        const name = card ? card.dataset.name : '?';
        removeCard(participantId);
        refreshCount();
        if (cards.size === 0 && !document.getElementById('empty-state')) {
            const div = document.createElement('div');
            div.className = 'live-empty muted';
            div.id = 'empty-state';
            div.textContent = 'Все участники отключились.';
            grid.appendChild(div);
        }
        logEvent(`Отключился <strong>${escapeHtml(name)}</strong>`, 'log-leave');
    });
    socket.on('participant:stale', ({ participantId, silentMs }) => {
        if (!cards.has(participantId)) return;
        if (!stale.has(participantId)) {
            const card = cards.get(participantId);
            logEvent(
                `<strong>${escapeHtml(card.dataset.name)}</strong> молчит ${Math.round(silentMs / 1000)} сек`,
                'log-warn'
            );
        }
        setCardStale(participantId, true);
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
