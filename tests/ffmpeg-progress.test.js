import { describe, it, expect, vi } from 'vitest';
import { createProgressParser } from '../src/services/video.js';

describe('createProgressParser', () => {
    it('emits frame number when full line ends with newline', () => {
        const cb = vi.fn();
        const p = createProgressParser(cb);
        p.feed('frame=  42 fps= 24 q=23.0\n');
        expect(cb).toHaveBeenCalledWith(42);
    });

    it('emits frame from \\r-terminated progress line (typical ffmpeg)', () => {
        const cb = vi.fn();
        const p = createProgressParser(cb);
        p.feed('frame=   1 fps=...\rframe=   2 fps=...\rframe=   3 fps=...\r');
        expect(cb).toHaveBeenCalledTimes(3);
        expect(cb.mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
    });

    it('emits frame even from incomplete buffer (no terminator yet)', () => {
        const cb = vi.fn();
        const p = createProgressParser(cb);
        p.feed('frame=  10 fps= 30 q=24');
        expect(cb).toHaveBeenCalledWith(10);
    });

    it('handles split chunks without losing frames', () => {
        const cb = vi.fn();
        const p = createProgressParser(cb);
        p.feed('fram');
        p.feed('e=  17 fps=20\r');
        // последовательность: после первого feed 'fram' — нет матча
        // после второго — 17 (один раз через парсинг buf или через split — в зависимости
        // от реализации может быть и 2 события, главное что 17 появилось)
        const frames = cb.mock.calls.map((c) => c[0]);
        expect(frames).toContain(17);
    });

    it('does nothing without onProgress callback', () => {
        const p = createProgressParser(null);
        // не падает
        p.feed('frame= 1 fps=1\r');
    });

    it('skips non-progress lines', () => {
        const cb = vi.fn();
        const p = createProgressParser(cb);
        p.feed('ffmpeg version 8.1.1 Copyright ...\n');
        p.feed('  Stream #0:0: Video: png ...\n');
        expect(cb).not.toHaveBeenCalled();
    });

    it('handles realistic ffmpeg output', () => {
        const cb = vi.fn();
        const p = createProgressParser(cb);
        // Эмулируем реальный stderr фрагмент.
        const realLog = [
            'ffmpeg version 8.1.1 Copyright (c) 2000-2026 the FFmpeg developers\n',
            '  built with Apple clang version 17.0.0\n',
            "Input #0, concat, from 'concat.txt':\n",
            '  Duration: N/A, start: 0.000000\n',
            'frame=    1 fps=0.0 q=0.0 size=N/A time=N/A bitrate=N/A speed=N/A    \r',
            'frame=    3 fps=3.0 q=24.0 size=     512kB time=00:00:01.50 bitrate=2796.2kbits/s speed=4.5x    \r',
            'frame=    5 fps=4.5 q=-1.0 Lsize=     1234kB time=00:00:02.50 bitrate=4032.3kbits/s speed=2.3x    \n',
        ];
        for (const chunk of realLog) p.feed(chunk);
        const frames = cb.mock.calls.map((c) => c[0]);
        expect(frames).toEqual(expect.arrayContaining([1, 3, 5]));
    });
});
