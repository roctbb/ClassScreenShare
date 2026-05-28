'use strict';

const crypto = require('crypto');
const { Participant } = require('../db/models');

const TOKEN_BYTES = 24; // 32 base64url-символа

function generateToken() {
    return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Найти существующего participant по exam_id и token (если cookie есть).
 * Возвращает Participant или null.
 */
async function findByToken(examId, token) {
    if (!token || typeof token !== 'string') return null;
    return Participant.findOne({ where: { examId, token } });
}

/**
 * Найти или создать participant.
 * Если передан валидный token (привязан к этому экзамену) — обновляем имя и
 * возвращаем существующего. Иначе — создаём нового.
 */
async function joinOrResume({ examId, name, token, ip = null, userAgent = null }) {
    const trimmed = String(name || '').trim();
    if (!trimmed) {
        const err = new Error('name is required');
        err.status = 400;
        throw err;
    }
    if (trimmed.length > 255) {
        const err = new Error('name is too long');
        err.status = 400;
        throw err;
    }

    if (token) {
        const existing = await findByToken(examId, token);
        if (existing) {
            // Если имя поменялось — обновим. Это нормальный кейс при reconnect
            // если человек открыл ссылку заново и ввёл имя.
            if (existing.name !== trimmed) {
                existing.name = trimmed;
            }
            existing.leftAt = null;
            await existing.save();
            return { participant: existing, resumed: true };
        }
    }

    const participant = await Participant.create({
        examId,
        name: trimmed,
        token: generateToken(),
        joinedAt: new Date(),
        ip,
        userAgent: userAgent ? String(userAgent).slice(0, 512) : null,
    });
    return { participant, resumed: false };
}

/**
 * Помечает участника как покинувшего экзамен.
 */
async function leave(participantId) {
    const p = await Participant.findByPk(participantId);
    if (!p) return null;
    p.leftAt = new Date();
    await p.save();
    return p;
}

/**
 * Обновить lastSeenAt (вызывается при каждом полученном кадре).
 * Делаем UPDATE без загрузки модели, чтобы не нагружать БД.
 */
async function touch(participantId, ts = new Date()) {
    await Participant.update({ lastSeenAt: ts }, { where: { id: participantId } });
}

module.exports = { generateToken, findByToken, joinOrResume, leave, touch };
