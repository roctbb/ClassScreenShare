/* eslint-env browser */
(function () {
    'use strict';

    const cfg = window.__PLAYER__;
    if (!cfg) return;
    const $ = (id) => document.getElementById(id);

    const SPEEDS = [0.5, 1, 1.5, 2, 4, 8];
    const player = $('player');
    const slideImg = $('slideshow-img');
    const playPauseBtn = $('play-pause');
    const speedsBox = $('speeds');
    const curTimeEl = $('cur-time');
    const totalTimeEl = $('total-time');
    const tlSvg = $('timeline');
    const tlTooltip = $('tl-tooltip');
    const tlWrap = tlSvg && tlSvg.parentElement;

    let timeline = null; // { totalDurationMs, frames, gaps, ... }
    let durationMs = 0;
    let speed = 1;

    // ------------------- Utils -------------------
    function fmtTime(ms) {
        if (!isFinite(ms) || ms < 0) ms = 0;
        const s = Math.floor(ms / 1000);
        const m = Math.floor(s / 60);
        const r = s % 60;
        return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
    }
    function buildSpeedButtons(onChange) {
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
                onChange(sp);
            });
            speedsBox.appendChild(b);
        });
    }

    // ------------------- Timeline -------------------
    /**
     * Рендерит SVG-таймлайн:
     *   - зелёный фон по всей длине (есть кадры)
     *   - красные блоки на gaps
     *   - индикатор текущей позиции
     */
    function renderTimeline() {
        if (!timeline || !timeline.totalDurationMs) return;
        const total = timeline.totalDurationMs;
        const W = 1000;
        const H = 40;
        const parts = [
            `<rect x="0" y="8" width="${W}" height="${H - 16}" rx="4" fill="#10b981" />`,
        ];
        for (const gap of timeline.gaps || []) {
            const x = (gap.startMs / total) * W;
            const w = ((gap.endMs - gap.startMs) / total) * W;
            const real = Math.round(gap.realDurationMs / 1000);
            parts.push(
                `<rect class="tl-gap" x="${x}" y="8" width="${w}" height="${H - 16}" fill="#ef4444"
                    data-real="${real}" data-startms="${gap.startMs}" data-endms="${gap.endMs}" />`
            );
        }
        // Индикатор позиции.
        parts.push(
            `<line id="tl-cursor" x1="0" y1="0" x2="0" y2="${H}" stroke="#1f2937" stroke-width="2" />`
        );
        tlSvg.innerHTML = parts.join('');

        // Tooltip + click + cursor.
        tlSvg.addEventListener('click', (e) => {
            const rect = tlSvg.getBoundingClientRect();
            const ratio = (e.clientX - rect.left) / rect.width;
            const targetMs = Math.max(0, Math.min(total, ratio * total));
            seekTo(targetMs);
        });
        tlSvg.addEventListener('mousemove', (e) => {
            const rect = tlSvg.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const ratio = x / rect.width;
            const ms = Math.max(0, Math.min(total, ratio * total));
            // Если над gap'ом — показать про связь.
            const target = e.target;
            if (target && target.classList && target.classList.contains('tl-gap')) {
                const real = target.getAttribute('data-real');
                tlTooltip.innerHTML = `<strong>Нет связи ${real} сек</strong><br><small>${fmtTime(ms)}</small>`;
            } else {
                tlTooltip.textContent = fmtTime(ms);
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
        const x = (ms / timeline.totalDurationMs) * 1000;
        cursor.setAttribute('x1', String(x));
        cursor.setAttribute('x2', String(x));
        curTimeEl.textContent = fmtTime(ms);
    }

    function seekTo(ms) {
        if (cfg.mode === 'video') {
            player.currentTime = ms / 1000;
        } else {
            slideshowState.currentMs = ms;
            updateSlideshow();
        }
    }

    // ------------------- Video mode -------------------
    async function initVideo() {
        try {
            const r = await fetch(cfg.timelineUrl, { credentials: 'same-origin' });
            if (r.ok) {
                timeline = await r.json();
                durationMs = timeline.totalDurationMs;
            }
        } catch (e) {
            console.warn('No timeline json, falling back to video duration only', e);
        }

        // Если нет таймлайна — построим минимальный из durations.
        player.addEventListener('loadedmetadata', () => {
            if (!timeline) {
                durationMs = Math.round(player.duration * 1000);
                timeline = { totalDurationMs: durationMs, gaps: [], frames: [] };
            }
            totalTimeEl.textContent = fmtTime(durationMs);
            renderTimeline();
        });
        player.addEventListener('timeupdate', () => {
            setCursor(player.currentTime * 1000);
        });

        buildSpeedButtons((sp) => {
            player.playbackRate = sp;
        });
    }

    // ------------------- Slideshow mode -------------------
    const slideshowState = {
        frames: [],
        timeline: null,
        currentMs: 0,
        playing: false,
        lastTickAt: 0,
        currentImgIdx: -1,
        rafId: null,
    };

    async function initSlideshow() {
        // Получим список кадров.
        const r = await fetch(cfg.framesUrl, { credentials: 'same-origin' });
        if (!r.ok) return;
        const data = await r.json();
        slideshowState.frames = data.frames;

        if (slideshowState.frames.length === 0) return;

        // Построим таймлайн на клиенте (та же логика что и в server side video.js).
        timeline = buildClientTimeline(slideshowState.frames);
        durationMs = timeline.totalDurationMs;
        slideshowState.timeline = timeline;
        totalTimeEl.textContent = fmtTime(durationMs);
        renderTimeline();
        // Покажем первый кадр.
        showFrameAt(0);

        playPauseBtn.addEventListener('click', () => {
            if (slideshowState.playing) {
                slideshowState.playing = false;
                playPauseBtn.textContent = '▶ Воспроизвести';
                if (slideshowState.rafId) cancelAnimationFrame(slideshowState.rafId);
            } else {
                if (slideshowState.currentMs >= durationMs) slideshowState.currentMs = 0;
                slideshowState.playing = true;
                playPauseBtn.textContent = '⏸ Пауза';
                slideshowState.lastTickAt = performance.now();
                tickSlideshow();
            }
        });

        buildSpeedButtons(() => {
            /* speed читается из state */
        });
    }

    function buildClientTimeline(frames) {
        const fps = 2;
        const maxGapMs = 5 * 1000; // те же дефолты что и на сервере
        const defaultDurationMs = Math.round(1000 / fps);
        const result = [];
        const gaps = [];
        let videoOffsetMs = 0;
        for (let i = 0; i < frames.length; i++) {
            const cur = frames[i];
            const next = frames[i + 1];
            let durationMs;
            if (next) {
                const realGap = next.ts - cur.ts;
                durationMs = Math.min(realGap, maxGapMs);
                if (realGap > maxGapMs) {
                    gaps.push({
                        startMs: videoOffsetMs,
                        endMs: videoOffsetMs + durationMs,
                        realDurationMs: realGap,
                    });
                }
            } else {
                durationMs = defaultDurationMs;
            }
            if (durationMs < defaultDurationMs) durationMs = defaultDurationMs;
            result.push({ id: cur.id, ts: cur.ts, vo: videoOffsetMs, d: durationMs });
            videoOffsetMs += durationMs;
        }
        return { totalDurationMs: videoOffsetMs, frames: result, gaps };
    }

    function showFrameAt(ms) {
        const frames = slideshowState.timeline.frames;
        // Найдём кадр, у которого vo <= ms < vo+d.
        let idx = 0;
        for (let i = 0; i < frames.length; i++) {
            if (ms >= frames[i].vo && ms < frames[i].vo + frames[i].d) {
                idx = i;
                break;
            }
            if (i === frames.length - 1 && ms >= frames[i].vo) idx = i;
        }
        if (idx !== slideshowState.currentImgIdx) {
            slideshowState.currentImgIdx = idx;
            slideImg.src = cfg.frameUrlBase + frames[idx].id;
        }
        setCursor(ms);
    }

    function updateSlideshow() {
        showFrameAt(slideshowState.currentMs);
    }

    function tickSlideshow() {
        if (!slideshowState.playing) return;
        const now = performance.now();
        const dt = (now - slideshowState.lastTickAt) * speed;
        slideshowState.lastTickAt = now;
        slideshowState.currentMs += dt;
        if (slideshowState.currentMs >= durationMs) {
            slideshowState.currentMs = durationMs;
            slideshowState.playing = false;
            playPauseBtn.textContent = '▶ Воспроизвести';
            updateSlideshow();
            return;
        }
        updateSlideshow();
        slideshowState.rafId = requestAnimationFrame(tickSlideshow);
    }

    // ------------------- Init -------------------
    if (cfg.mode === 'video') initVideo();
    else if (cfg.mode === 'slideshow') initSlideshow();
})();
