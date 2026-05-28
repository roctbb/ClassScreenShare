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

module.exports = {
    recordSocketEvent,
    listForParticipant,
};
