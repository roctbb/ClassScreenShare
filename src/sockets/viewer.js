'use strict';

const { Exam, Participant, User, Frame } = require('../db/models');
const bus = require('../services/bus');
const config = require('../config');
const logger = require('../logger');
const participantConnectionsService = require('../services/participantConnections');

/**
 * Привязывает express-session middleware к указанному socket.io namespace.
 */
function bindSessionToNamespace(ns, sessionMiddleware) {
    ns.use((socket, next) => sessionMiddleware(socket.request, {}, next));
}

/**
 * Карта examId -> Map<participantId, lastFrameTs>
 * Общая для всех viewer'ов, используется stale-детектором.
 */
const lastFrameMap = new Map();

function getOrCreate(examId) {
    if (!lastFrameMap.has(examId)) lastFrameMap.set(examId, new Map());
    return lastFrameMap.get(examId);
}

let registered = false;
let staleTimerInstance = null;

/**
 * Регистрирует bus listeners и stale-таймер. Идемпотентен — повторные вызовы не дублируют.
 * Возвращает { staleTimer } для graceful shutdown.
 */
function registerBusListeners(ns) {
    if (registered) return { staleTimer: staleTimerInstance };
    registered = true;

    bus.on('frame', ({ examId, participantId, ts, dataUrl }) => {
        getOrCreate(examId).set(participantId, ts);
        ns.to(`exam:${examId}`).emit('frame', { participantId, ts, dataUrl });
    });
    bus.on('join', ({ examId, participantId, name }) => {
        const event = participantConnectionsService.serializeLiveEvent(
            { participantId, event: 'connect' },
            { participantId, name }
        );
        ns.to(`exam:${examId}`).emit('participant:join', {
            participantId,
            name,
            online: true,
            createdAt: event.createdAt,
        });
    });
    bus.on('leave', ({ examId, participantId, name, reason }) => {
        const m = lastFrameMap.get(examId);
        if (m) m.delete(participantId);
        const event = participantConnectionsService.serializeLiveEvent(
            { participantId, event: 'disconnect', reason },
            { participantId, name }
        );
        ns.to(`exam:${examId}`).emit('participant:leave', {
            participantId,
            name,
            reason,
            reasonLabel: event.reasonLabel,
            online: false,
            createdAt: event.createdAt,
        });
    });

    // При завершении экзамена — чистим in-memory state.
    bus.on('exam:finished', ({ examId }) => {
        lastFrameMap.delete(examId);
    });

    // Прогресс конвертации видео.
    bus.on('recording:status', (payload) => {
        if (!payload || !payload.examId) return;
        ns.to(`exam:${payload.examId}`).emit('recording:status', payload);
    });
    bus.on('recording:progress', (payload) => {
        if (!payload || !payload.examId) return;
        ns.to(`exam:${payload.examId}`).emit('recording:progress', payload);
    });

    // Stale-детектор: раз в 3 сек.
    staleTimerInstance = setInterval(() => {
        const now = Date.now();
        const threshold = config.inactivityTimeout;
        for (const [examId, parts] of lastFrameMap) {
            for (const [participantId, lastTs] of parts) {
                const silentMs = now - lastTs;
                if (silentMs > threshold) {
                    ns.to(`exam:${examId}`).emit('participant:stale', {
                        participantId,
                        silentMs,
                    });
                }
            }
        }
    }, 3000);
    staleTimerInstance.unref();

    return { staleTimer: staleTimerInstance };
}

/**
 * Подключает /viewer namespace для админ-мониторинга.
 */
function attachViewer(io, sessionMiddleware) {
    const ns = io.of('/viewer');
    bindSessionToNamespace(ns, sessionMiddleware);

    ns.use(async (socket, next) => {
        try {
            const session = socket.request.session;
            if (!session || !session.userId) return next(new Error('unauthorized'));
            const user = await User.findByPk(session.userId);
            if (!user) return next(new Error('unauthorized'));
            socket.data.userId = user.id;
            socket.data.userLogin = user.login;
            next();
        } catch (err) {
            logger.error({ err: err.message }, 'viewer handshake error');
            next(new Error('internal_error'));
        }
    });

    const { staleTimer } = registerBusListeners(ns);

    ns.on('connection', (socket) => {
        const { userId, userLogin } = socket.data;
        logger.info({ userId, userLogin }, 'viewer connected');

        socket.on('subscribe', async (payload, ack) => {
            try {
                const examId = Number(payload && payload.examId);
                if (!Number.isInteger(examId) || examId <= 0) {
                    if (typeof ack === 'function') ack({ ok: false, reason: 'bad_examId' });
                    return;
                }
                const exam = await Exam.findByPk(examId);
                if (!exam) {
                    if (typeof ack === 'function') ack({ ok: false, reason: 'not_found' });
                    return;
                }

                // Покинуть прошлые комнаты.
                for (const room of socket.rooms) {
                    if (room.startsWith('exam:')) socket.leave(room);
                }
                socket.join(`exam:${examId}`);

                // Определяем кто онлайн прямо сейчас — берём из publisher namespace.
                const publisherNs = io.of('/publisher');
                const publisherSockets = await publisherNs.in(`exam:${examId}`).fetchSockets();
                const onlineIds = new Set(
                    publisherSockets.map((s) => Number(s.data.participantId)).filter(Boolean)
                );

                const participants = await Participant.findAll({
                    where: { examId },
                    order: [['joined_at', 'ASC']],
                });
                const lastFrames = await Promise.all(
                    participants.map((p) =>
                        Frame.findOne({
                            where: { participantId: p.id },
                            order: [['ts', 'DESC']],
                            attributes: ['ts'],
                        })
                    )
                );
                const logEvents = await participantConnectionsService.listLiveEventsForExam(examId);
                if (typeof ack === 'function') {
                    ack({
                        ok: true,
                        exam: {
                            id: exam.id,
                            name: exam.name,
                            code: exam.code,
                            status: exam.status,
                            captureInterval: exam.captureInterval,
                        },
                        participants: participants.map((p, i) => ({
                            id: p.id,
                            name: p.name,
                            joinedAt: p.joinedAt,
                            online: onlineIds.has(p.id),
                            lastFrameTs: lastFrames[i] ? Number(lastFrames[i].ts) : null,
                        })),
                        logEvents,
                    });
                }
            } catch (err) {
                logger.error({ err: err.message }, 'viewer subscribe error');
                if (typeof ack === 'function') ack({ ok: false, reason: 'internal_error' });
            }
        });

        socket.on('disconnect', (reason) => {
            logger.info({ userId, reason }, 'viewer disconnected');
        });
    });

    return { ns, staleTimer };
}

module.exports = { attachViewer };
