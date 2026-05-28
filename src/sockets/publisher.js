'use strict';

const cookie = require('cookie');
const { Participant, Exam } = require('../db/models');
const framesService = require('../services/frames');
const participantsService = require('../services/participants');
const participantConnectionsService = require('../services/participantConnections');
const bus = require('../services/bus');
const config = require('../config');
const logger = require('../logger');
const { PARTICIPANT_COOKIE } = require('../routes/exam');

/**
 * Подключает /publisher namespace к io.
 *
 * Аутентификация на handshake'е:
 *   - читаем cookie cs.participant
 *   - находим Participant по этому токену
 *   - убеждаемся, что соответствующий Exam в статусе active
 *
 * События:
 *   client -> server  'frame'  { dataUrl }     — новый кадр
 *   client -> server  'leave'                  — корректное завершение
 *   server -> client  'kicked' { reason }     — экзамен завершён или ошибка
 *   server -> client  'frame:ack' { ts, ok, reason? }  — подтверждение/отказ
 */
function attachPublisher(io) {
    const ns = io.of('/publisher');

    // При завершении экзамена выкидываем всех активных publishers'ов из его комнаты.
    bus.on('exam:finished', ({ examId }) => {
        const room = `exam:${examId}`;
        ns.in(room)
            .fetchSockets()
            .then((sockets) => {
                for (const s of sockets) {
                    s.data.disconnectReason = 'exam_finished';
                    s.emit('kicked', { reason: 'exam_finished' });
                    s.disconnect(true);
                }
            })
            .catch((err) => logger.error({ err: err.message }, 'failed to kick on exam:finished'));
    });

    ns.use(async (socket, next) => {
        try {
            const raw = socket.handshake.headers.cookie || '';
            const cookies = cookie.parse(raw || '');
            const token = cookies[PARTICIPANT_COOKIE];
            if (!token) return next(new Error('no_token'));

            const participant = await Participant.findOne({ where: { token } });
            if (!participant) return next(new Error('invalid_token'));

            const exam = await Exam.findByPk(participant.examId);
            if (!exam) return next(new Error('exam_not_found'));
            if (exam.status !== Exam.STATUS.ACTIVE) {
                return next(new Error('exam_not_active'));
            }

            socket.data.participantId = participant.id;
            socket.data.examId = exam.id;
            socket.data.captureInterval = exam.captureInterval;
            socket.data.participantName = participant.name;
            next();
        } catch (err) {
            logger.error({ err: err.message }, 'publisher handshake error');
            next(new Error('internal_error'));
        }
    });

    ns.on('connection', (socket) => {
        const { examId, participantId, participantName, captureInterval } = socket.data;

        logger.info(
            { examId, participantId, name: participantName, socketId: socket.id },
            'publisher connected'
        );
        participantConnectionsService.recordSocketEvent(socket, 'connect').catch(() => {});
        socket.join(`exam:${examId}`);

        bus.emit('join', {
            examId,
            participantId,
            name: participantName,
        });

        socket.on('frame', async (payload, ack) => {
            try {
                const dataUrl = payload && typeof payload === 'object' ? payload.dataUrl : null;
                if (typeof dataUrl !== 'string') {
                    if (typeof ack === 'function') ack({ ok: false, reason: 'bad_payload' });
                    return;
                }
                if (dataUrl.length > config.maxFrameBytes * 1.4) {
                    // base64 ~ 4/3 от bytes; даём небольшой запас.
                    if (typeof ack === 'function') ack({ ok: false, reason: 'too_large' });
                    return;
                }

                const result = await framesService.saveFrame({
                    examId,
                    participantId,
                    captureInterval,
                    dataUrl,
                });

                if (result.ok) {
                    // Не блокируем — touch идёт в фоне.
                    participantsService.touch(participantId, new Date(result.ts)).catch(() => {});
                    // Пробрасываем кадр в live-мониторинг.
                    bus.emit('frame', {
                        examId,
                        participantId,
                        ts: result.ts,
                        dataUrl,
                    });
                }
                if (typeof ack === 'function') ack(result);
            } catch (err) {
                logger.error({ err: err.message, participantId }, 'frame handler error');
                if (typeof ack === 'function') ack({ ok: false, reason: 'internal_error' });
            }
        });

        socket.on('leave', async () => {
            try {
                await participantsService.leave(participantId);
                socket.data.disconnectReason = 'student_leave';
            } catch (err) {
                logger.warn({ err: err.message }, 'leave error');
            }
            socket.disconnect(true);
        });

        socket.on('disconnect', (reason) => {
            const finalReason = socket.data.disconnectReason || reason;
            logger.info(
                { examId, participantId, reason: finalReason, socketId: socket.id },
                'publisher disconnected'
            );
            participantConnectionsService
                .recordSocketEvent(socket, 'disconnect', finalReason)
                .catch(() => {});
            framesService.clearState(participantId);
            bus.emit('leave', { examId, participantId });
        });
    });

    return ns;
}

module.exports = { attachPublisher };
