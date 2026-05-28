'use strict';

const { ParticipantConnection } = require('../db/models');
const logger = require('../logger');

function truncate(value, max) {
    if (value === null || value === undefined) return null;
    const str = String(value);
    return str.length > max ? str.slice(0, max) : str;
}

function socketIp(socket) {
    return (
        (socket.handshake.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
        socket.handshake.address ||
        null
    );
}

async function recordSocketEvent(socket, event, reason = null) {
    const participantId = Number(socket.data.participantId);
    const examId = Number(socket.data.examId);
    if (!Number.isInteger(participantId) || !Number.isInteger(examId)) return null;

    try {
        return await ParticipantConnection.create({
            participantId,
            examId,
            socketId: truncate(socket.id, 128),
            event,
            reason: truncate(reason, 128),
            ip: truncate(socketIp(socket), 64),
            userAgent: truncate(socket.handshake.headers['user-agent'], 512),
        });
    } catch (err) {
        logger.warn({ err: err.message, participantId, examId, event }, 'connection log failed');
        return null;
    }
}

async function listForParticipant(participantId, { limit = 100 } = {}) {
    return ParticipantConnection.findAll({
        where: { participantId },
        order: [['created_at', 'DESC']],
        limit,
    });
}

/**
 * Грузит логи всех участников экзамена одним запросом и группирует по participantId.
 * Возвращает Map<participantId, ParticipantConnection[]>.
 */
async function listForExam(examId) {
    const logs = await ParticipantConnection.findAll({
        where: { examId },
        order: [['created_at', 'ASC']],
    });
    const byParticipant = new Map();
    for (const log of logs) {
        const pid = log.participantId;
        if (!byParticipant.has(pid)) byParticipant.set(pid, []);
        byParticipant.get(pid).push(log);
    }
    return byParticipant;
}

function valueOf(event, camel, snake) {
    if (!event) return null;
    if (typeof event.get === 'function') {
        const value = event.get(camel);
        if (value !== undefined) return value;
    }
    return event[camel] ?? event[snake] ?? null;
}

function shortSocketId(socketId) {
    const id = String(socketId || '');
    if (id.length <= 12) return id;
    return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function humanReason(reason) {
    const map = {
        student_leave: 'ученик завершил',
        exam_finished: 'экзамен завершён',
        'transport close': 'соединение закрыто',
        'transport error': 'ошибка транспорта',
        'ping timeout': 'нет ответа',
        'client namespace disconnect': 'клиент отключился',
        'server namespace disconnect': 'сервер отключил',
    };
    return map[reason] || reason || '';
}

function durationLabel(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours > 0) return `${hours} ч ${mins} мин`;
    if (minutes > 0) return `${minutes} мин ${seconds} сек`;
    return `${seconds} сек`;
}

function buildConnectionSessions(events, { now = new Date() } = {}) {
    const sorted = [...events].sort((a, b) => {
        const aTime = new Date(valueOf(a, 'createdAt', 'created_at')).getTime();
        const bTime = new Date(valueOf(b, 'createdAt', 'created_at')).getTime();
        return aTime - bTime;
    });
    const openBySocket = new Map();
    const sessions = [];

    for (const event of sorted) {
        const socketId = valueOf(event, 'socketId', 'socket_id');
        const eventType = valueOf(event, 'event', 'event');
        const createdAt = valueOf(event, 'createdAt', 'created_at');
        const key = socketId || `unknown-${sessions.length}`;

        if (eventType === 'connect') {
            const session = {
                socketId,
                socketShort: shortSocketId(socketId),
                startedAt: createdAt,
                endedAt: null,
                status: 'active',
                reason: '',
                reasonLabel: '',
                ip: valueOf(event, 'ip', 'ip'),
                userAgent: valueOf(event, 'userAgent', 'user_agent'),
            };
            sessions.push(session);
            openBySocket.set(key, session);
            continue;
        }

        if (eventType === 'disconnect') {
            const session = openBySocket.get(key);
            if (session) {
                session.endedAt = createdAt;
                session.status = 'closed';
                session.reason = valueOf(event, 'reason', 'reason') || '';
                session.reasonLabel = humanReason(session.reason);
                openBySocket.delete(key);
            } else {
                sessions.push({
                    socketId,
                    socketShort: shortSocketId(socketId),
                    startedAt: null,
                    endedAt: createdAt,
                    status: 'closed',
                    reason: valueOf(event, 'reason', 'reason') || '',
                    reasonLabel: humanReason(valueOf(event, 'reason', 'reason')),
                    ip: valueOf(event, 'ip', 'ip'),
                    userAgent: valueOf(event, 'userAgent', 'user_agent'),
                });
            }
        }
    }

    const nowMs = new Date(now).getTime();
    for (const session of sessions) {
        const startMs = session.startedAt ? new Date(session.startedAt).getTime() : NaN;
        const endMs = session.endedAt ? new Date(session.endedAt).getTime() : nowMs;
        session.durationMs = startMs ? endMs - startMs : null;
        session.durationLabel = durationLabel(session.durationMs);
    }

    sessions.sort((a, b) => {
        const aTime = new Date(a.startedAt || a.endedAt).getTime();
        const bTime = new Date(b.startedAt || b.endedAt).getTime();
        return bTime - aTime;
    });

    const activeSessions = sessions.filter((session) => session.status === 'active').length;
    const totalAbsenceMs = calcTotalAbsenceMs(sessions);
    return {
        sessions,
        summary: {
            activeSessions,
            totalSessions: sessions.length,
            isOnline: activeSessions > 0,
            lastSession: sessions[0] || null,
            totalAbsenceMs,
            totalAbsenceLabel: durationLabel(totalAbsenceMs),
        },
    };
}

/**
 * Считает суммарное время отсутствия (разрывы между сессиями).
 * Сначала мержит перекрывающиеся сессии, затем суммирует промежутки между ними.
 */
function calcTotalAbsenceMs(sessions) {
    // Берём только сессии с известным началом.
    const intervals = sessions
        .filter((s) => s.startedAt)
        .map((s) => ({
            start: new Date(s.startedAt).getTime(),
            end: s.endedAt ? new Date(s.endedAt).getTime() : Date.now(),
        }))
        .sort((a, b) => a.start - b.start);

    if (intervals.length < 2) return 0;

    // Мержим перекрывающиеся интервалы.
    const merged = [{ ...intervals[0] }];
    for (let i = 1; i < intervals.length; i++) {
        const last = merged[merged.length - 1];
        if (intervals[i].start <= last.end) {
            last.end = Math.max(last.end, intervals[i].end);
        } else {
            merged.push({ ...intervals[i] });
        }
    }

    // Суммируем промежутки между смёрженными интервалами.
    let totalMs = 0;
    for (let i = 1; i < merged.length; i++) {
        totalMs += merged[i].start - merged[i - 1].end;
    }
    return Math.max(0, totalMs);
}

module.exports = {
    recordSocketEvent,
    listForParticipant,
    listForExam,
    buildConnectionSessions,
    durationLabel,
    calcTotalAbsenceMs,
};
