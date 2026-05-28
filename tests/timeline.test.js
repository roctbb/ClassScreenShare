import { describe, it, expect } from 'vitest';
import { buildTimeline } from '../src/services/video.js';

// Хелпер для удобной генерации кадров.
function makeFrames(timestamps) {
    return timestamps.map((ts, i) => ({ ts, filePath: `f${i}.webp` }));
}

describe('buildTimeline', () => {
    it('returns empty for no frames', () => {
        const r = buildTimeline([]);
        expect(r.frames).toEqual([]);
        expect(r.totalDurationMs).toBe(0);
        expect(r.gaps).toEqual([]);
    });

    it('uses default duration (1000/fps) for the only/last frame', () => {
        const r = buildTimeline(makeFrames([1000]), { fps: 2 });
        expect(r.frames).toHaveLength(1);
        expect(r.frames[0].videoOffsetMs).toBe(0);
        expect(r.frames[0].durationMs).toBe(500); // 1000/2
        expect(r.totalDurationMs).toBe(500);
        expect(r.gaps).toEqual([]);
    });

    it('uses real interval when within maxGap', () => {
        const r = buildTimeline(makeFrames([1000, 2500, 4000]), { fps: 2, maxGapSeconds: 5 });
        expect(r.frames[0].durationMs).toBe(1500);
        expect(r.frames[1].durationMs).toBe(1500);
        expect(r.frames[2].durationMs).toBe(500);
        expect(r.frames[0].videoOffsetMs).toBe(0);
        expect(r.frames[1].videoOffsetMs).toBe(1500);
        expect(r.frames[2].videoOffsetMs).toBe(3000);
        expect(r.totalDurationMs).toBe(3500);
        expect(r.gaps).toEqual([]);
    });

    it('caps long gap to maxGapSeconds and records it', () => {
        // Кадры: 0ms, +2sec, +10sec (большой gap), +1sec
        const r = buildTimeline(makeFrames([1000, 3000, 13000, 14000]), {
            fps: 2,
            maxGapSeconds: 3,
            expectedFrameIntervalMs: 1000,
        });
        // Между [3000] и [13000] gap = 10s, ограничен до 3s.
        expect(r.frames[1].durationMs).toBe(3000);
        // gap зафиксирован.
        expect(r.gaps).toHaveLength(1);
        expect(r.gaps[0].realDurationMs).toBe(10000);
        // Сначала показываем последний доставленный кадр один tick, затем чёрный gap.
        expect(r.gaps[0].startMs).toBe(2500);
        expect(r.gaps[0].endMs).toBe(2000 + 3000); // конец gap'а в видео
    });

    it('records multiple gaps in correct order with cumulative offsets', () => {
        const r = buildTimeline(makeFrames([0, 1000, 100000, 101000, 200000]), {
            fps: 2,
            maxGapSeconds: 5,
            expectedFrameIntervalMs: 1000,
        });
        // Два gap'а: [1000..100000] = 99s -> capped to 5s, [101000..200000] = 99s -> capped to 5s.
        expect(r.gaps).toHaveLength(2);
        expect(r.gaps[0].realDurationMs).toBe(99000);
        expect(r.gaps[1].realDurationMs).toBe(99000);
        // Первый gap начинается после короткого показа последнего доставленного кадра.
        expect(r.gaps[0].startMs).toBe(1500);
        expect(r.gaps[0].endMs).toBe(6000);
        // После gap'а кадр idx=2 (101000) начинается в video t=6000, длится 1000.
        expect(r.frames[2].videoOffsetMs).toBe(6000);
        expect(r.frames[2].durationMs).toBe(1000);
        // Второй gap.
        expect(r.gaps[1].startMs).toBe(7500);
    });

    it('does not record a gap when exactly three frames are missed', () => {
        // При интервале 1250ms разрыв 5000ms означает ровно 3 пропущенных кадра.
        const r = buildTimeline(makeFrames([0, 5000]), {
            fps: 2,
            maxGapSeconds: 5,
            expectedFrameIntervalMs: 1250,
        });
        expect(r.gaps).toEqual([]);
        expect(r.frames[0].durationMs).toBe(5000);
    });

    it('records a gap only when more than three frames are missed', () => {
        const r = buildTimeline(makeFrames([0, 5001]), {
            fps: 2,
            maxGapSeconds: 5,
            expectedFrameIntervalMs: 1250,
        });
        expect(r.gaps).toHaveLength(1);
        expect(r.frames[0].durationMs).toBe(5000);
    });

    it('clamps too-short durations to default (rate-limit edge case)', () => {
        // На сервере минимальный интервал capture_interval/2, но если в БД
        // окажутся кадры ближе друг к другу, мы не должны делать durationMs
        // меньше defaultDurationMs (1/fps).
        const r = buildTimeline(
            makeFrames([1000, 1100]), // 100ms — сильно меньше 1/fps=500ms
            { fps: 2, maxGapSeconds: 5 }
        );
        expect(r.frames[0].durationMs).toBe(500); // защита от слишком коротких
    });

    it('uses provided fps to compute default duration of last frame', () => {
        const r1 = buildTimeline(makeFrames([1000]), { fps: 1 });
        expect(r1.frames[0].durationMs).toBe(1000);
        const r4 = buildTimeline(makeFrames([1000]), { fps: 4 });
        expect(r4.frames[0].durationMs).toBe(250);
    });
});
