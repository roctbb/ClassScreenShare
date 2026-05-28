import { describe, it, expect } from 'vitest';
import { generateCode, safeNext, CODE_ALPHABET, CODE_LENGTH } from '../src/lib/util.js';

describe('generateCode', () => {
    it('returns string of expected length by default', () => {
        const c = generateCode();
        expect(c).toHaveLength(CODE_LENGTH);
    });

    it('honors custom length', () => {
        const c = generateCode(12);
        expect(c).toHaveLength(12);
    });

    it('uses only characters from the safe alphabet', () => {
        for (let i = 0; i < 200; i++) {
            const c = generateCode();
            for (const ch of c) {
                expect(CODE_ALPHABET).toContain(ch);
            }
        }
    });

    it('does not contain visually ambiguous characters', () => {
        for (let i = 0; i < 200; i++) {
            const c = generateCode();
            // 0/O/1/I/l не должны встречаться.
            expect(c).not.toMatch(/[0O1Il]/);
        }
    });

    it('produces different codes (collision is unlikely)', () => {
        const seen = new Set();
        for (let i = 0; i < 500; i++) seen.add(generateCode());
        expect(seen.size).toBeGreaterThan(490);
    });
});

describe('safeNext', () => {
    it('accepts internal absolute paths', () => {
        expect(safeNext('/admin')).toBe('/admin');
        expect(safeNext('/admin/exams/1')).toBe('/admin/exams/1');
    });

    it('rejects protocol-relative URLs (open redirect)', () => {
        expect(safeNext('//evil.com/foo')).toBe('/admin');
    });

    it('rejects external absolute URLs', () => {
        expect(safeNext('https://evil.com/foo')).toBe('/admin');
        expect(safeNext('http://localhost/foo')).toBe('/admin');
    });

    it('rejects empty/null inputs', () => {
        expect(safeNext('')).toBe('/admin');
        expect(safeNext(null)).toBe('/admin');
        expect(safeNext(undefined)).toBe('/admin');
    });

    it('uses provided fallback', () => {
        expect(safeNext(null, '/custom')).toBe('/custom');
        expect(safeNext('//x.com', '/custom')).toBe('/custom');
    });

    it('rejects non-strings', () => {
        expect(safeNext(42)).toBe('/admin');
        expect(safeNext({ url: '/admin' })).toBe('/admin');
    });
});
