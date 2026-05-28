'use strict';

const crypto = require('crypto');

/**
 * Алфавит для коротких кодов экзаменов.
 * Без похожих символов: 0/O, 1/I/l, без пунктуации.
 * 32 символа → 5 бит на символ → 8 символов = ~40 бит = достаточно для уникальности.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

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

/**
 * Безопасный редирект — только относительные пути в рамках нашего домена.
 */
function safeNext(input, fallback = '/admin') {
    if (!input || typeof input !== 'string') return fallback;
    if (!input.startsWith('/') || input.startsWith('//')) return fallback;
    return input;
}

module.exports = { generateCode, safeNext, CODE_ALPHABET, CODE_LENGTH };
