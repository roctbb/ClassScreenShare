/* eslint-env browser */
(function () {
    'use strict';

    const cfg = window.__PLAYER__;
    if (!cfg) return;
    const $ = (id) => document.getElementById(id);

    const SPEEDS = [0.5, 1, 1.5, 2, 4, 8];
    const slideImg = $('slideshow-img');
    const playPauseBtn = $('play-pause');
    const speedsBox = $('speeds');
    const curTimeEl = $('cur-time');
    const totalTimeEl = $('total-time');
    const tlSvg = $('timeline');
    const tlTooltip = $('tl-tooltip');
    const tlWrap = tlSvg && tlSvg.parentElement;
    const examTimeOverlay = $('exam-time-overlay');
    const gapIndicator = $('gap-indicator');

    let timeline = null;
    let durationMs = 0;
    let speed = 1;

    const state = {
        frames: [],
        currentMs: 0,
        playing: false,
        lastTickAt: 0,
        currentImgIdx: -1,
        rafId: null,
    };

    // ------------------- Utils -------------------
    function fmtTime(ms) {
        if (!isFinite(ms) || ms < 0) ms = 0;
        const s = Math.floor(ms / 1000);
        const m = Math.floor(s / 60);
        const r = s % 60;
        return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
    }

    function fmtExamTime(ms) {
        if (!isFinite(ms) || ms < 0) ms = 0;
        const s = Math.floor(ms / 1000);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const r = s % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
    }

    function buildSpeedButtons() {
        speedsBox.innerHTML = '';
        SPEEDS.forEach((sp) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'btn btn-sm btn-secondary' + (sp === 1 ? ' active' : '');
            b.textContent = sp + 'x';
            b.dataset.speed = String(sp);
            b.addEventListener('click', () => {
                speed = sp;
                speedsBox
                    .querySelectorAll('button')
                    .forEach((x) => x.classList.toggle('active', Number(x.dataset.speed) === sp));
            });
            speedsBox.appendChild(b);
        });
    }

    // ------------------- Timeline SVG -------------------
    function renderTimeline() {
        if (!timeline || !timeline.totalDurationMs) return;
        const total = timeline.realTotalDurationMs || timeline.totalDurationMs;
        const W = 1000;
        const H = 40;
        const parts = [
            `<rect x="0" y="8" width="${W}" height="${H - 16}" rx="4" fill="#10b981" />`,
        ];
        for (const gap of timeline.gaps || []) {
            const startMs = gap.realStartMs ?? gap.startMs;
            const endMs = gap.realEndMs ?? gap.endMs;
            const x = (startMs / total) * W;
            const w = Math.max(2, ((endMs - startMs) / total) * W);
            const real = Math.round(gap.realDurationMs / 1000);
            parts.push(
                `<rect class="tl-gap" x="${x}" y="8" width="${w}" height="${H - 16}" fill="#ef4444"` +
                    ` data-real="${real}" data-startms="${startMs}" data-endms="${endMs}" />`
            );
        }
        parts.push(
            `<line id="tl-cursor" x1="0" y1="0" x2="0" y2="${H}" stroke="#1f2937" stroke-width="2" />`
        );
        tlSvg.innerHTML = parts.join('');

        tlSvg.addEventListener('click', (e) => {
            const rect = tlSvg.getBoundingClientRect();
            const ratio = (e.clientX - rect.left) / rect.width;
            const displayMs = Math.max(0, Math.min(total, ratio * total));
            seekTo(displayToVideoMs(displayMs));
        });
        tlSvg.addEventListener('mousemove', (e) => {
            const rect = tlSvg.getBoundingClientRect();
            const ratio = (e.clientX - rect.left) / rect.width;
            const displayMs = Math.max(0, Math.min(total, ratio * total));
            const target = e.target;
            if (target && target.classList && target.classList.contains('tl-gap')) {
                const real = target.getAttribute('data-real');
                tlTooltip.innerHTML = `<strong>Нет связи ${real} сек</strong><br><small>${fmtTime(displayMs)}</small>`;
            } else {
                tlTooltip.textContent = fmtTime(displayMs);
            }
            tlTooltip.classList.remove('hidden');
            const wrapRect = tlWrap.getBoundingClientRect();
            tlTooltip.style.left = e.clientX - wrapRect.left + 'px';
        });
        tlSvg.addEventListener('mouseleave', () => tlTooltip.classList.add('hidden'));
    }

    function setCursor(ms) {
        const cursor = document.getElementById('tl-cursor');
        if (!cursor || !timeline || !timeline.totalDurationMs) return;
        const total = timeline.realTotalDurationMs || timeline.totalDurationMs;
        const displayMs = recordingElapsedAtVideoMs(ms);
        const x = (displayMs / total) * 1000;
        cursor.setAttribute('x1', String(x));
        cursor.setAttribute('x2', String(x));
        curTimeEl.textContent = fmtTime(displayMs);
    }

    function seekTo(ms) {
        state.currentMs = ms;
        updateSlideshow();
    }

    // ------------------- Gap detection -------------------
    function isInGap(ms) {
        if (!timeline || !timeline.gaps) return false;
        for (const gap of timeline.gaps) {
            if (ms >= gap.startMs && ms < gap.endMs) return true;
        }
        return false;
    }

    // ------------------- Slideshow -------------------
    function buildClientTimeline(frames) {
        const maxGapMs = (cfg.maxGapSeconds || 5) * 1000;
        const defaultDurationMs = 500; // 2fps
        const expectedFrameIntervalMs = Number(
            cfg.expectedFrameIntervalMs || cfg.captureInterval || 5000
        );
        const maxMissedFrames = Number(cfg.maxMissedFrames ?? 3);
        const gapThresholdMs = expectedFrameIntervalMs * (maxMissedFrames + 1);
        const result = [];
        const gaps = [];
        let offset = 0;
        const firstTs = frames.length ? Number(frames[0].ts) : 0;
        for (let i = 0; i < frames.length; i++) {
            const cur = frames[i];
            const next = frames[i + 1];
            let d;
            if (next) {
                const realGap = next.ts - cur.ts;
                const isConnectionGap = realGap > gapThresholdMs;
                d = isConnectionGap ? Math.min(realGap, maxGapMs) : realGap;
                if (isConnectionGap) {
                    const gapStartMs = offset + Math.min(defaultDurationMs, d);
                    const realStartMs = cur.ts - firstTs + Math.min(defaultDurationMs, d);
                    const realEndMs = next.ts - firstTs;
                    gaps.push({
                        startMs: gapStartMs,
                        endMs: offset + d,
                        realStartMs,
                        realEndMs,
                        realDurationMs: realGap,
                    });
                }
            } else {
                d = defaultDurationMs;
            }
            if (d < defaultDurationMs) d = defaultDurationMs;
            result.push({ id: cur.id, ts: cur.ts, vo: offset, d });
            offset += d;
        }
        return {
            totalDurationMs: offset,
            realTotalDurationMs: result.length
                ? result[result.length - 1].ts - firstTs + result[result.length - 1].d
                : 0,
            frames: result,
            gaps,
        };
    }

    function showFrameAt(ms) {
        const frames = timeline.frames;
        let idx = frames.length - 1;
        for (let i = 0; i < frames.length; i++) {
            if (ms >= frames[i].vo && ms < frames[i].vo + frames[i].d) {
                idx = i;
                break;
            }
        }
        const inGap = isInGap(ms);

        // Во время gap — чёрный кадр (не обновляем src, скрываем img).
        const wrap = slideImg.parentElement;
        if (inGap) {
            slideImg.style.visibility = 'hidden';
            if (wrap) wrap.classList.add('player-wrap-gap');
        } else {
            slideImg.style.visibility = '';
            if (wrap) wrap.classList.remove('player-wrap-gap');
            if (idx !== state.currentImgIdx) {
                state.currentImgIdx = idx;
                slideImg.src = cfg.frameUrlBase + frames[idx].id;
            }
        }
        setCursor(ms);

        // Время от начала экзамена — считаем плавно с учётом видео-времени и реальной растяжки в gap'ах.
        // Если у старого экзамена нет started_at, считаем от первого полученного кадра.
        if (examTimeOverlay) {
            const elapsed = examElapsedAtVideoMs(ms);
            examTimeOverlay.textContent = fmtExamTime(Math.max(0, elapsed));
        }

        // Индикация пропуска (текстовый бейдж).
        if (gapIndicator) {
            gapIndicator.classList.toggle('hidden', !inGap);
        }
    }

    /**
     * Считает реальное время с начала экзамена в позиции videoMs.
     * В gap'ах видео-время сжато до maxGapMs, а реальное продолжает идти —
     * интерполируем линейно от ts начала gap до ts конца gap.
     */
    function realTimestampAtVideoMs(videoMs) {
        const frames = timeline.frames;
        if (!frames.length) return 0;

        // Найдём кадр, в котором videoMs.
        let idx = frames.length - 1;
        for (let i = 0; i < frames.length; i++) {
            if (videoMs >= frames[i].vo && videoMs < frames[i].vo + frames[i].d) {
                idx = i;
                break;
            }
        }
        const cur = frames[idx];
        const next = frames[idx + 1];
        const realIntervalMs = next ? next.ts - cur.ts : cur.d;
        // Доля прохождения текущего "слота" в видео.
        const localFrac = cur.d > 0 ? (videoMs - cur.vo) / cur.d : 0;
        // Реальный момент = ts текущего кадра + доля * реальный интервал
        return cur.ts + localFrac * realIntervalMs;
    }

    function recordingElapsedAtVideoMs(videoMs) {
        const frames = timeline.frames;
        if (!frames.length) return 0;
        return realTimestampAtVideoMs(videoMs) - frames[0].ts;
    }

    function examElapsedAtVideoMs(videoMs) {
        const frames = timeline.frames;
        if (!frames.length) return 0;
        return realTimestampAtVideoMs(videoMs) - (cfg.examStartedAt || frames[0].ts);
    }

    function displayToVideoMs(displayMs) {
        const frames = timeline.frames;
        if (!frames.length) return 0;
        const targetTs = frames[0].ts + displayMs;
        let idx = frames.length - 1;
        for (let i = 0; i < frames.length - 1; i++) {
            if (targetTs >= frames[i].ts && targetTs < frames[i + 1].ts) {
                idx = i;
                break;
            }
        }
        const cur = frames[idx];
        const next = frames[idx + 1];
        const realIntervalMs = next ? next.ts - cur.ts : cur.d;
        const localFrac = realIntervalMs > 0 ? (targetTs - cur.ts) / realIntervalMs : 0;
        return Math.max(0, Math.min(timeline.totalDurationMs, cur.vo + localFrac * cur.d));
    }

    function updateSlideshow() {
        showFrameAt(state.currentMs);
    }

    function tick() {
        if (!state.playing) return;
        const now = performance.now();
        const dt = (now - state.lastTickAt) * speed;
        state.lastTickAt = now;
        state.currentMs += dt;
        if (state.currentMs >= durationMs) {
            state.currentMs = durationMs;
            state.playing = false;
            playPauseBtn.textContent = 'Воспроизвести';
            updateSlideshow();
            return;
        }
        updateSlideshow();
        state.rafId = requestAnimationFrame(tick);
    }

    async function init() {
        const r = await fetch(cfg.framesUrl, { credentials: 'same-origin' });
        if (!r.ok) return;
        const data = await r.json();
        state.frames = data.frames;
        if (state.frames.length === 0) return;

        timeline = buildClientTimeline(state.frames);
        durationMs = timeline.totalDurationMs;
        totalTimeEl.textContent = fmtTime(timeline.realTotalDurationMs || durationMs);
        renderTimeline();
        showFrameAt(0);

        playPauseBtn.addEventListener('click', () => {
            if (state.playing) {
                state.playing = false;
                playPauseBtn.textContent = 'Воспроизвести';
                if (state.rafId) cancelAnimationFrame(state.rafId);
            } else {
                if (state.currentMs >= durationMs) state.currentMs = 0;
                state.playing = true;
                playPauseBtn.textContent = 'Пауза';
                state.lastTickAt = performance.now();
                tick();
            }
        });

        buildSpeedButtons();
    }

    init();
})();
