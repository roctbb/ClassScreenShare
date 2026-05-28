/* eslint-env browser */
(function () {
    'use strict';

    const cfg = window.__EXAM__;
    const $ = (id) => document.getElementById(id);

    const stepShare = $('step-share');
    const stepRecording = $('step-recording');
    const startBtn = $('start-share');
    const leaveBtn = $('leave-btn');
    const preview = $('preview');
    const framesSent = $('frames-sent');
    const lastFrame = $('last-frame');
    const recStatus = $('rec-status');
    const connStatus = $('conn-status');
    const connText = $('conn-text');

    const state = {
        socket: null,
        stream: null,
        canvas: null,
        ctx: null,
        videoEl: null,
        captureTimer: null,
        watchdogTimer: null,
        sent: 0,
        connected: false,
        audioCtx: null,
        beepTimer: null,
        lastAcceptedFrameAt: 0,
        captureStopped: false,
        intentionalStop: false,
    };

    function show(el) {
        el.classList.remove('hidden');
    }
    function hide(el) {
        el.classList.add('hidden');
    }

    function setConn(s) {
        connStatus.classList.remove('conn-connected', 'conn-disconnected', 'conn-warn');
        if (s === 'ok') {
            connStatus.classList.add('conn-connected');
            connText.textContent = 'Подключено';
        } else if (s === 'warn') {
            connStatus.classList.add('conn-warn');
            connText.textContent = 'Переподключение…';
        } else {
            connStatus.classList.add('conn-disconnected');
            connText.textContent = 'Связь потеряна';
        }
    }

    // ----- Звуковой сигнал при потере связи -----
    function ensureAudio() {
        if (state.audioCtx) return;
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            state.audioCtx = new Ctx();
            if (state.audioCtx.state === 'suspended') state.audioCtx.resume().catch(() => {});
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
        o.connect(g);
        g.connect(ctx.destination);
        const t = ctx.currentTime;
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

    // ----- Захват экрана -----
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
        state.captureStopped = false;
        state.intentionalStop = false;
        state.lastAcceptedFrameAt = Date.now();
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.srcObject = state.stream;
        await video.play();
        state.videoEl = video;
        preview.srcObject = state.stream;

        state.canvas = document.createElement('canvas');
        state.ctx = state.canvas.getContext('2d');

        state.stream.getVideoTracks().forEach((t) => {
            t.addEventListener('ended', () => {
                state.captureStopped = true;
                recStatus.textContent =
                    'Демонстрация остановлена. Перезагрузите страницу, чтобы возобновить.';
                if (state.captureTimer) {
                    clearInterval(state.captureTimer);
                    state.captureTimer = null;
                }
                if (state.watchdogTimer) {
                    clearInterval(state.watchdogTimer);
                    state.watchdogTimer = null;
                }
                if (!state.intentionalStop) startBeeping();
            });
        });

        connectSocket();
        hide(stepShare);
        show(stepRecording);
        startCaptureLoop();
    }

    function startCaptureLoop() {
        if (state.captureTimer) clearInterval(state.captureTimer);
        if (state.watchdogTimer) clearInterval(state.watchdogTimer);
        state.captureTimer = setInterval(captureAndSend, cfg.captureInterval);
        state.watchdogTimer = setInterval(checkFrameWatchdog, 1000);
        captureAndSend();
    }

    function checkFrameWatchdog() {
        if (state.captureStopped || state.intentionalStop) return;
        if (!state.stream || !state.videoEl) return;
        const thresholdMs = Math.max(cfg.captureInterval * 2.5, 10000);
        const lastOk = state.lastAcceptedFrameAt || 0;
        if (lastOk && Date.now() - lastOk > thresholdMs) {
            recStatus.textContent =
                'Кадры не отправляются. Проверьте демонстрацию экрана и соединение.';
            startBeeping();
        }
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
                state.lastAcceptedFrameAt = Date.now();
                framesSent.textContent = String(state.sent);
                lastFrame.textContent = new Date().toLocaleTimeString('ru-RU');
                recStatus.textContent = 'Идёт передача';
                if (state.connected && !state.captureStopped) stopBeeping();
            } else if (ack.reason !== 'rate_limited') {
                recStatus.textContent = 'Кадр не принят: ' + ack.reason;
                startBeeping();
            }
        } catch {
            recStatus.textContent = 'Ошибка отправки кадра';
            startBeeping();
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
            if (!state.captureStopped) stopBeeping();
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
            state.intentionalStop = true;
            const reason = info && info.reason ? info.reason : 'unknown';
            recStatus.textContent =
                reason === 'exam_finished'
                    ? 'Экзамен завершён преподавателем. Передача остановлена.'
                    : 'Соединение разорвано сервером (' + reason + ').';
            if (state.captureTimer) {
                clearInterval(state.captureTimer);
                state.captureTimer = null;
            }
            if (state.watchdogTimer) {
                clearInterval(state.watchdogTimer);
                state.watchdogTimer = null;
            }
            if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
            socket.io.opts.reconnection = false;
            socket.disconnect();
            stopBeeping();
        });
    }

    startBtn.addEventListener('click', startSharing);

    leaveBtn.addEventListener('click', async () => {
        if (!confirm('Завершить демонстрацию и покинуть экзамен?')) return;
        state.intentionalStop = true;
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
        if (state.watchdogTimer) clearInterval(state.watchdogTimer);
        location.href = '/';
    });

    window.addEventListener('beforeunload', () => {
        state.intentionalStop = true;
        try {
            if (state.socket) state.socket.disconnect();
        } catch {
            /* ignore */
        }
    });
})();
