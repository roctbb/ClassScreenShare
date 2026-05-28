/* eslint-env browser */
(function () {
    'use strict';

    const cfg = window.__EXAM__;
    const $ = (id) => document.getElementById(id);

    const stepName = $('step-name');
    const stepShare = $('step-share');
    const stepRecording = $('step-recording');
    const nameForm = $('name-form');
    const nameInput = $('name');
    const nameError = $('name-error');
    const helloName = $('hello-name');
    const startBtn = $('start-share');
    const leaveBtn = $('leave-btn');
    const preview = $('preview');
    const framesSent = $('frames-sent');
    const lastFrame = $('last-frame');
    const recStatus = $('rec-status');
    const connStatus = $('conn-status');
    const connText = $('conn-text');

    const state = {
        participantName: cfg.participant ? cfg.participant.name : '',
        socket: null,
        stream: null,
        canvas: null,
        ctx: null,
        videoEl: null,
        captureTimer: null,
        sent: 0,
        lastSentTs: 0,
        connected: false,
        // Звуковой сигнал
        audioCtx: null,
        beepTimer: null,
    };

    // ----- UI helpers -----
    function show(el) {
        el.classList.remove('hidden');
    }
    function hide(el) {
        el.classList.add('hidden');
    }
    function setStep(name) {
        hide(stepName);
        hide(stepShare);
        hide(stepRecording);
        if (name === 'name') show(stepName);
        if (name === 'share') show(stepShare);
        if (name === 'recording') show(stepRecording);
    }
    function setConn(state) {
        connStatus.classList.remove('conn-connected', 'conn-disconnected', 'conn-warn');
        if (state === 'ok') {
            connStatus.classList.add('conn-connected');
            connText.textContent = 'Подключено';
        } else if (state === 'warn') {
            connStatus.classList.add('conn-warn');
            connText.textContent = 'Переподключение…';
        } else {
            connStatus.classList.add('conn-disconnected');
            connText.textContent = 'Связь потеряна';
        }
    }

    // ----- Звуковой сигнал -----
    // Создаётся только после первого user gesture (клика), чтобы обойти autoplay.
    function ensureAudio() {
        if (state.audioCtx) return;
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            state.audioCtx = new Ctx();
        } catch {
            state.audioCtx = null;
        }
    }
    function beep() {
        if (!state.audioCtx) return;
        const ctx = state.audioCtx;
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = 880;
        g.gain.value = 0.0;
        o.connect(g);
        g.connect(ctx.destination);
        const t = ctx.currentTime;
        // Короткий "бип-бип"
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.25, t + 0.02);
        g.gain.setValueAtTime(0.25, t + 0.1);
        g.gain.linearRampToValueAtTime(0, t + 0.13);
        g.gain.linearRampToValueAtTime(0.25, t + 0.2);
        g.gain.setValueAtTime(0.25, t + 0.3);
        g.gain.linearRampToValueAtTime(0, t + 0.33);
        o.start(t);
        o.stop(t + 0.35);
    }
    function startBeeping() {
        if (state.beepTimer) return;
        beep();
        state.beepTimer = setInterval(beep, 3000);
    }
    function stopBeeping() {
        if (state.beepTimer) {
            clearInterval(state.beepTimer);
            state.beepTimer = null;
        }
    }

    // ----- Join (POST к API, ставит cookie) -----
    async function join(name) {
        const res = await fetch('/api/exam/' + encodeURIComponent(cfg.code) + '/join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ name }),
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Ошибка подключения (HTTP ' + res.status + ')');
        }
        return res.json();
    }

    // ----- Запуск демонстрации экрана -----
    async function startSharing() {
        ensureAudio();
        try {
            state.stream = await navigator.mediaDevices.getDisplayMedia({
                video: { displaySurface: 'monitor' },
                audio: false,
                preferCurrentTab: false,
            });
        } catch (err) {
            alert('Не удалось получить доступ к экрану: ' + err.message);
            return;
        }
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.srcObject = state.stream;
        await video.play();
        state.videoEl = video;
        preview.srcObject = state.stream;

        const canvas = document.createElement('canvas');
        state.canvas = canvas;
        state.ctx = canvas.getContext('2d');

        // Обработка остановки участником через UI браузера ("Stop sharing").
        state.stream.getVideoTracks().forEach((t) => {
            t.addEventListener('ended', () => {
                recStatus.textContent =
                    'Демонстрация остановлена. Перезагрузите страницу, чтобы возобновить.';
                if (state.captureTimer) {
                    clearInterval(state.captureTimer);
                    state.captureTimer = null;
                }
            });
        });

        connectSocket();
        setStep('recording');
        startCaptureLoop();
    }

    function startCaptureLoop() {
        if (state.captureTimer) clearInterval(state.captureTimer);
        state.captureTimer = setInterval(captureAndSend, cfg.captureInterval);
    }

    async function captureAndSend() {
        if (!state.connected || !state.videoEl) return;
        const v = state.videoEl;
        if (!v.videoWidth || v.readyState < 2) return;

        const targetWidth = cfg.imageWidth;
        const scale = targetWidth / v.videoWidth;
        const targetHeight = Math.round(v.videoHeight * scale);
        if (state.canvas.width !== targetWidth) state.canvas.width = targetWidth;
        if (state.canvas.height !== targetHeight) state.canvas.height = targetHeight;
        state.ctx.drawImage(v, 0, 0, targetWidth, targetHeight);
        const dataUrl = state.canvas.toDataURL('image/webp', cfg.imageQuality);

        try {
            const ack = await new Promise((resolve) => {
                let resolved = false;
                state.socket.timeout(8000).emit('frame', { dataUrl }, (err, res) => {
                    if (resolved) return;
                    resolved = true;
                    if (err) resolve({ ok: false, reason: 'timeout' });
                    else resolve(res || { ok: false, reason: 'no_response' });
                });
            });
            if (ack.ok) {
                state.sent++;
                state.lastSentTs = Date.now();
                framesSent.textContent = String(state.sent);
                lastFrame.textContent = new Date(state.lastSentTs).toLocaleTimeString('ru-RU');
                recStatus.textContent = 'Идёт передача';
            } else {
                if (ack.reason === 'rate_limited') {
                    // Это норма — просто пропустим этот кадр.
                } else {
                    recStatus.textContent = 'Кадр не принят: ' + ack.reason;
                }
            }
        } catch {
            recStatus.textContent = 'Ошибка отправки кадра';
        }
    }

    function connectSocket() {
        const socket = io('/publisher', {
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            timeout: 20000,
            withCredentials: true,
        });
        state.socket = socket;

        socket.on('connect', () => {
            state.connected = true;
            setConn('ok');
            stopBeeping();
        });
        socket.on('disconnect', () => {
            state.connected = false;
            setConn('off');
            startBeeping();
        });
        socket.on('connect_error', (err) => {
            state.connected = false;
            setConn('warn');
            startBeeping();
            recStatus.textContent = 'Ошибка соединения: ' + (err.message || err);
        });
        socket.io.on('reconnect_attempt', () => setConn('warn'));

        socket.on('kicked', (info) => {
            // Сервер сказал отключиться (например, экзамен завершён).
            const reason = info && info.reason ? info.reason : 'unknown';
            const msg =
                reason === 'exam_finished'
                    ? 'Экзамен завершён преподавателем. Передача остановлена.'
                    : 'Соединение разорвано сервером (' + reason + ').';
            recStatus.textContent = msg;
            if (state.captureTimer) {
                clearInterval(state.captureTimer);
                state.captureTimer = null;
            }
            if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
            // Не реконнектимся.
            socket.io.opts.reconnection = false;
            socket.disconnect();
            stopBeeping();
        });
    }

    // ----- Wiring -----
    if (cfg.participant) {
        helloName.textContent = state.participantName;
        setStep('share');
    } else {
        setStep('name');
    }

    nameForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        nameError.classList.add('hidden');
        const name = nameInput.value.trim();
        if (!name) {
            nameError.textContent = 'Введите имя';
            nameError.classList.remove('hidden');
            return;
        }
        try {
            const data = await join(name);
            state.participantName = data.participant.name;
            helloName.textContent = state.participantName;
            setStep('share');
        } catch (err) {
            nameError.textContent = err.message;
            nameError.classList.remove('hidden');
        }
    });

    startBtn.addEventListener('click', () => {
        // Если cookie уже есть, но в БД participant'а нет (например, экзамен пересоздали),
        // socket connect упадёт с no_token. Перед стартом ещё раз обновим join.
        join(state.participantName)
            .then(startSharing)
            .catch((err) => {
                alert('Не удалось подтвердить участника: ' + err.message);
            });
    });

    leaveBtn.addEventListener('click', async () => {
        if (!confirm('Завершить демонстрацию и покинуть экзамен?')) return;
        try {
            if (state.socket) state.socket.emit('leave');
        } catch {
            /* ignore */
        }
        try {
            await fetch('/api/exam/' + encodeURIComponent(cfg.code) + '/leave', {
                method: 'POST',
                credentials: 'same-origin',
            });
        } catch {
            /* ignore */
        }
        if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
        if (state.captureTimer) clearInterval(state.captureTimer);
        location.href = '/';
    });

    // Если страница закрывается — попытаемся уведомить сервер об отключении.
    // Это best-effort.
    window.addEventListener('beforeunload', () => {
        try {
            if (state.socket) state.socket.disconnect();
        } catch {
            /* ignore */
        }
    });
})();
