'use strict';

const fs = require('fs/promises');
const path = require('path');
const { Frame } = require('../db/models');
const config = require('../config');
const logger = require('../logger');

const RECORDINGS_DIR = config.recordingsDir;

// Кэш существующих директорий, чтобы не делать mkdir при каждом кадре.
const ensuredDirs = new Set();

// Inflight-счётчики на участника — back-pressure.
// Если у одного участника уже >= MAX_INFLIGHT кадров пишутся, новые дропаем.
const inflight = new Map(); // participantId -> count
const MAX_INFLIGHT = 3;

// Защита от слишком частых кадров (на случай если клиент уйдёт в флуд).
// Минимальный интервал = capture_interval / 2.
const lastAccepted = new Map(); // participantId -> ts (ms)

async function ensureDir(absDir) {
    if (ensuredDirs.has(absDir)) return;
    await fs.mkdir(absDir, { recursive: true });
    ensuredDirs.add(absDir);
}

/**
 * Парсит data URL вида "data:image/webp;base64,...." и возвращает Buffer.
 * Возвращает null при невалидном формате.
 */
function decodeDataUrl(dataUrl) {
    if (typeof dataUrl !== 'string') return null;
    // Принимаем только image/webp и image/jpeg на всякий случай.
    const m = dataUrl.match(/^data:image\/(webp|jpeg|png);base64,(.+)$/);
    if (!m) return null;
    try {
        return { ext: m[1], buffer: Buffer.from(m[2], 'base64') };
    } catch {
        return null;
    }
}

function relPath(examId, participantId, ts, ext) {
    return path.posix.join(
        `exam_${examId}`,
        `participant_${participantId}`,
        'frames',
        `${ts}.${ext}`
    );
}

/**
 * Принимает кадр от participant, записывает его на диск и в БД.
 * Возвращает результат (saved/dropped) — для передачи обратно по сокету и
 * подсчёта статистики.
 *
 * @param {object} args
 * @param {number} args.examId
 * @param {object} args.participant   модель Participant (нужны id и captureInterval из exam)
 * @param {number} args.captureInterval  минимальный интервал между кадрами в мс
 * @param {string} args.dataUrl       base64 data URL
 * @param {number} [args.maxBytes]    лимит на размер кадра
 */
async function saveFrame({
    examId,
    participantId,
    captureInterval,
    dataUrl,
    maxBytes = config.maxFrameBytes,
}) {
    // 1. Rate limit.
    const now = Date.now();
    const last = lastAccepted.get(participantId) || 0;
    const minInterval = Math.max(250, Math.floor(captureInterval / 2));
    if (now - last < minInterval) {
        return { ok: false, reason: 'rate_limited' };
    }

    // 2. Back-pressure.
    const inflightCount = inflight.get(participantId) || 0;
    if (inflightCount >= MAX_INFLIGHT) {
        return { ok: false, reason: 'backpressure' };
    }

    // 3. Декодинг + проверка размера.
    const decoded = decodeDataUrl(dataUrl);
    if (!decoded) {
        return { ok: false, reason: 'invalid_format' };
    }
    if (decoded.buffer.length > maxBytes) {
        return { ok: false, reason: 'too_large' };
    }

    // 4. Резервируем слот в lastAccepted и inflight ДО записи, чтобы быстрые
    // повторные кадры успешно отбрасывались.
    lastAccepted.set(participantId, now);
    inflight.set(participantId, inflightCount + 1);

    try {
        const ts = now;
        const rel = relPath(examId, participantId, ts, decoded.ext);
        const abs = path.join(RECORDINGS_DIR, rel);
        await ensureDir(path.dirname(abs));
        await fs.writeFile(abs, decoded.buffer);

        await Frame.create({
            participantId,
            ts,
            filePath: rel,
            sizeBytes: decoded.buffer.length,
        });

        return { ok: true, ts, size: decoded.buffer.length, path: rel };
    } catch (err) {
        logger.error({ err: err.message, participantId }, 'failed to save frame');
        return { ok: false, reason: 'io_error' };
    } finally {
        const c = (inflight.get(participantId) || 1) - 1;
        if (c <= 0) inflight.delete(participantId);
        else inflight.set(participantId, c);
    }
}

/**
 * Очистить in-memory state по participantId (при leave).
 */
function clearState(participantId) {
    inflight.delete(participantId);
    lastAccepted.delete(participantId);
}

module.exports = { saveFrame, clearState };
