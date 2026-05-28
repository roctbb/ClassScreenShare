'use strict';

const { Participant } = require('../db/models');

/**
 * Найти или создать participant по geekclass_id (дедупликация).
 * Если участник с таким geekclass_id уже есть в этом экзамене — обновляем имя и возвращаем.
 */
async function joinOrResume({ examId, name, geekclassId, ip = null, userAgent = null }) {
    const trimmed = String(name || '').trim();
    if (!trimmed) {
        const err = new Error('name is required');
        err.status = 400;
        throw err;
    }
    if (!geekclassId) {
        const err = new Error('geekclassId is required');
        err.status = 400;
        throw err;
    }

    // Дедупликация по geekclass_id.
    const existing = await Participant.findOne({
        where: { examId, geekclassId: String(geekclassId) },
    });
    if (existing) {
        existing.name = trimmed;
        existing.leftAt = null;
        await existing.save();
        return { participant: existing, resumed: true };
    }

    const participant = await Participant.create({
        examId,
        name: trimmed,
        geekclassId: String(geekclassId),
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
 * Throttled per participant — БД обновляется не чаще раза в TOUCH_INTERVAL_MS.
 */
const TOUCH_INTERVAL_MS = 5000;
const lastTouchAt = new Map(); // participantId -> ms
const pendingTouch = new Map(); // participantId -> latest ts

async function touch(participantId, ts = new Date()) {
    const now = Date.now();
    const last = lastTouchAt.get(participantId) || 0;
    pendingTouch.set(participantId, ts);
    if (now - last < TOUCH_INTERVAL_MS) {
        return;
    }
    lastTouchAt.set(participantId, now);
    const tsToWrite = pendingTouch.get(participantId);
    pendingTouch.delete(participantId);
    await Participant.update({ lastSeenAt: tsToWrite }, { where: { id: participantId } });
}

/**
 * Финальный flush для участника при отключении — пишет последний pending ts.
 */
async function flushTouch(participantId) {
    const ts = pendingTouch.get(participantId);
    pendingTouch.delete(participantId);
    lastTouchAt.delete(participantId);
    if (ts) {
        await Participant.update({ lastSeenAt: ts }, { where: { id: participantId } });
    }
}

/**
 * Найти участника по geekclass_id в рамках экзамена.
 */
async function findByGeekclassId(examId, geekclassId) {
    if (!geekclassId) return null;
    return Participant.findOne({ where: { examId, geekclassId: String(geekclassId) } });
}

module.exports = { joinOrResume, leave, touch, flushTouch, findByGeekclassId };
