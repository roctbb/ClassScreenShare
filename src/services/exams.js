'use strict';

const fs = require('fs/promises');
const path = require('path');
const { UniqueConstraintError } = require('sequelize');
const { Exam, Participant, Frame, Recording, sequelize } = require('../db/models');
const { generateCode } = require('../lib/util');
const config = require('../config');
const logger = require('../logger');
const bus = require('./bus');

const MAX_CODE_RETRIES = 5;

/**
 * Создаёт экзамен. На коллизии кода делает retry.
 */
async function createExam({ name, createdBy }) {
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

    for (let i = 0; i < MAX_CODE_RETRIES; i++) {
        try {
            return await Exam.create({
                name: trimmed,
                code: generateCode(),
                status: Exam.STATUS.DRAFT,
                createdBy: createdBy || null,
                captureInterval: config.capture.interval,
                imageQuality: config.capture.quality,
                imageWidth: config.capture.width,
            });
        } catch (err) {
            if (err instanceof UniqueConstraintError && err.fields && err.fields.code) {
                logger.warn({ attempt: i + 1 }, 'exam code collision, retrying');
                continue;
            }
            throw err;
        }
    }
    throw new Error('failed to generate unique exam code after retries');
}

/**
 * Список экзаменов с количеством участников.
 */
async function listExams() {
    return Exam.findAll({
        order: [
            ['status', 'ASC'], // active первыми (active < draft < finished не так, но норм)
            ['created_at', 'DESC'],
        ],
        attributes: {
            include: [
                [
                    sequelize.literal(
                        '(SELECT COUNT(*)::int FROM participants WHERE participants.exam_id = "Exam"."id")'
                    ),
                    'participantCount',
                ],
            ],
        },
    });
}

async function getExamById(id) {
    return Exam.findByPk(id);
}

async function getExamByCode(code) {
    return Exam.findOne({ where: { code: String(code).toUpperCase() } });
}

async function renameExam(id, name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) {
        const err = new Error('name is required');
        err.status = 400;
        throw err;
    }
    const exam = await Exam.findByPk(id);
    if (!exam) return null;
    exam.name = trimmed;
    await exam.save();
    return exam;
}

async function activateExam(id) {
    const exam = await Exam.findByPk(id);
    if (!exam) return null;
    if (exam.status === Exam.STATUS.ACTIVE) return exam;
    if (exam.status === Exam.STATUS.FINISHED) {
        const err = new Error('cannot reactivate a finished exam');
        err.status = 400;
        throw err;
    }
    exam.status = Exam.STATUS.ACTIVE;
    exam.startedAt = exam.startedAt || new Date();
    await exam.save();
    return exam;
}

async function finishExam(id) {
    const exam = await Exam.findByPk(id);
    if (!exam) return null;
    if (exam.status === Exam.STATUS.FINISHED) return exam;
    exam.status = Exam.STATUS.FINISHED;
    exam.finishedAt = new Date();
    await exam.save();
    bus.emit('exam:finished', { examId: exam.id });

    // Авто-конвертация всех участников с кадрами.
    // Делаем это после bus.emit, чтобы publishers успели отключиться и не
    // дописывать кадры в момент построения timeline.
    setImmediate(async () => {
        try {
            const participants = await Participant.findAll({
                where: { examId: exam.id },
                attributes: ['id'],
            });
            // Загружаем video service лениво, чтобы избежать циклической зависимости.
            const videoService = require('./video');
            for (const p of participants) {
                const frameCount = await Frame.count({ where: { participantId: p.id } });
                if (frameCount === 0) continue;
                videoService.enqueueConvert(p.id).catch((err) => {
                    logger.warn({ err: err.message, participantId: p.id }, 'auto-convert failed');
                });
            }
            logger.info({ examId: exam.id, count: participants.length }, 'auto-convert queued');
        } catch (err) {
            logger.error({ err: err.message, examId: exam.id }, 'auto-convert error');
        }
    });

    return exam;
}

/**
 * Безопасное удаление директории внутри RECORDINGS_DIR.
 * Возвращает true если что-то удалено, false если не было ничего.
 */
async function safeRemoveDir(relPath) {
    if (!relPath || relPath.includes('..') || path.isAbsolute(relPath)) {
        throw new Error('refusing to remove unsafe path: ' + relPath);
    }
    const abs = path.resolve(path.join(config.recordingsDir, relPath));
    const root = path.resolve(config.recordingsDir);
    if (!abs.startsWith(root + path.sep)) {
        throw new Error('refusing to remove path outside recordings dir: ' + abs);
    }
    try {
        await fs.rm(abs, { recursive: true, force: true });
        return true;
    } catch (err) {
        if (err.code === 'ENOENT') return false;
        throw err;
    }
}

/**
 * Удаление экзамена. Каскадно удаляет participants, frames, recordings,
 * затем чистит директорию экзамена с диска.
 */
async function deleteExam(id) {
    const exam = await Exam.findByPk(id);
    if (!exam) return false;
    const examIdNum = exam.id;
    await exam.destroy();
    // Чистим файлы.
    try {
        await safeRemoveDir(`exam_${examIdNum}`);
    } catch (err) {
        logger.error({ err: err.message, examId: examIdNum }, 'failed to remove exam files');
    }
    return true;
}

/**
 * Удаляет участника. CASCADE снесёт frames + recording, потом чистим директорию.
 */
async function deleteParticipant(participantId) {
    const participant = await Participant.findByPk(participantId);
    if (!participant) return false;
    const examId = participant.examId;
    await participant.destroy();
    try {
        await safeRemoveDir(`exam_${examId}/participant_${participantId}`);
    } catch (err) {
        logger.error(
            { err: err.message, participantId, examId },
            'failed to remove participant files'
        );
    }
    return true;
}

/**
 * Список участников экзамена с агрегатами по кадрам.
 */
async function listParticipants(examId) {
    return Participant.findAll({
        where: { examId },
        order: [['joined_at', 'ASC']],
        include: [{ model: Recording, as: 'recording', required: false }],
        attributes: {
            include: [
                [
                    sequelize.literal(
                        '(SELECT COUNT(*)::int FROM frames WHERE frames.participant_id = "Participant"."id")'
                    ),
                    'frameCount',
                ],
                [
                    sequelize.literal(
                        '(SELECT MIN(ts) FROM frames WHERE frames.participant_id = "Participant"."id")'
                    ),
                    'firstFrameTs',
                ],
                [
                    sequelize.literal(
                        '(SELECT MAX(ts) FROM frames WHERE frames.participant_id = "Participant"."id")'
                    ),
                    'lastFrameTs',
                ],
            ],
        },
    });
}

module.exports = {
    createExam,
    listExams,
    getExamById,
    getExamByCode,
    renameExam,
    activateExam,
    finishExam,
    deleteExam,
    deleteParticipant,
    listParticipants,
    safeRemoveDir,
};
