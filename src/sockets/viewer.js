'use strict';

const { Exam, Participant, User, Frame } = require('../db/models');
const bus = require('../services/bus');
const config = require('../config');
const logger = require('../logger');

/**
 * Привязывает express-session middleware к указанному socket.io namespace.
 * После этого внутри socket.handshake req будет иметь session.
 */
function bindSessionToNamespace(ns, sessionMiddleware) {
    ns.use((socket, next) => sessionMiddleware(socket.request, {}, next));
}

/**
 * Подключает /viewer namespace для админ-мониторинга.
 *
 * Аутентификация: проверяем что в сессии есть userId и что юзер существует.
 * Подписка: после connect клиент шлёт 'subscribe' { examId } и присоединяется
 * к комнате 'exam:<examId>'.
 *
 * Сервер слушает bus и forward'ит события в комнаты:
 *   - frame  → эмитит 'frame' в exam:<examId> комнату
 *   - join   → эмитит 'participant:join' в exam:<examId>
 *   - leave  → эмитит 'participant:leave' в exam:<examId>
 *
 * Stale-детектор: раз в 3 сек проходит по всем участникам активных экзаменов
 * (отслеживает last frame ts in-memory) и шлёт 'participant:stale' если
 * молчание > INACTIVITY_TIMEOUT.
 */
function attachViewer(io, sessionMiddleware) {
    const ns = io.of('/viewer');

    // session middleware → ns.use, чтобы только viewer namespace требовал сессию.
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

    // Карта examId -> Map<participantId, lastFrameTs>
    // Используется для stale-детектора, общая на всех viewer'ов.
    const lastFrameMap = new Map();

    function getOrCreate(examId) {
        if (!lastFrameMap.has(examId)) lastFrameMap.set(examId, new Map());
        return lastFrameMap.get(examId);
    }

    // Подписки на bus — единые на всё приложение, не на каждого viewer.
    bus.on('frame', ({ examId, participantId, ts, dataUrl }) => {
        getOrCreate(examId).set(participantId, ts);
        ns.to(`exam:${examId}`).emit('frame', { participantId, ts, dataUrl });
    });
    bus.on('join', ({ examId, participantId, name }) => {
        ns.to(`exam:${examId}`).emit('participant:join', { participantId, name });
    });
    bus.on('leave', ({ examId, participantId }) => {
        const m = lastFrameMap.get(examId);
        if (m) m.delete(participantId);
        ns.to(`exam:${examId}`).emit('participant:leave', { participantId });
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

    // Stale-детектор: раз в 3 сек проверяем участников.
    const staleTimer = setInterval(() => {
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
    staleTimer.unref();

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

                // Отдадим текущее состояние: список участников и последние кадры.
                const participants = await Participant.findAll({
                    where: { examId, leftAt: null },
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
                            lastFrameTs: lastFrames[i] ? Number(lastFrames[i].ts) : null,
                        })),
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

    return ns;
}

module.exports = { attachViewer };
