'use strict';

const crypto = require('crypto');

/**
 * Алфавит для коротких кодов экзаменов.
 * Без похожих символов: 0/O, 1/I/l, без пунктуации.
 * 32 символа → 5 бит на символ → 8 символов = ~40 бит = достаточно для уникальности.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const MANUAL_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,15}$/;

/**
 * Генерирует случайный код экзамена.
 * Уникальность не гарантируется — вызывающий код должен делать retry на коллизии.
 */
function generateCode(length = CODE_LENGTH) {
    const bytes = crypto.randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++) {
        out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
    return out;
}

function normalizeExamCode(input) {
    const code = String(input || '')
        .trim()
        .toUpperCase();
    if (!code) return '';
    if (!MANUAL_CODE_RE.test(code)) {
        const err = new Error('exam code must be 3..16 chars: A-Z, 0-9, _ or -');
        err.status = 400;
        throw err;
    }
    return code;
}

/**
 * Безопасный редирект — только относительные пути в рамках нашего домена.
 */
function safeNext(input, fallback = '/admin') {
    if (!input || typeof input !== 'string') return fallback;
    if (!input.startsWith('/') || input.startsWith('//')) return fallback;
    return input;
}

module.exports = {
    generateCode,
    normalizeExamCode,
    safeNext,
    CODE_ALPHABET,
    CODE_LENGTH,
    MANUAL_CODE_RE,
};
