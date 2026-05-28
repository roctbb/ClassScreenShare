'use strict';

const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { Frame, Recording, Participant, Exam } = require('../db/models');
const config = require('../config');
const logger = require('../logger');
const bus = require('./bus');

const RECORDINGS_DIR = config.recordingsDir;

// Очередь задач: участники, которых надо конвертировать.
// Обработка запускается с concurrency = config.video.concurrency.
const queue = [];
const inProgress = new Set(); // participantId
let activeWorkers = 0;

/**
 * Строит таймлайн из кадров.
 * Для каждого кадра вычисляется его смещение в результирующем видео.
 *
 * Возвращает:
 *   {
 *     frames: [{ ts, filePath, videoOffsetMs, durationMs }],
 *     totalDurationMs,
 *     gaps: [{ startMs, endMs, realDurationMs }]   // только реально длинные пропуски
 *   }
 *
 * gaps использует videoTime, чтобы плеер мог их подсветить на таймлайне.
 */
function buildTimeline(frames, options = {}) {
    const fps = options.fps || config.video.fps;
    const maxGapMs = (options.maxGapSeconds || config.video.maxGapSeconds) * 1000;
    const defaultDurationMs = Math.round(1000 / fps);
    const expectedFrameIntervalMs = Number(
        options.expectedFrameIntervalMs || options.captureInterval || config.capture.interval
    );
    const maxMissedFrames = Number(options.maxMissedFrames ?? 3);
    const gapThresholdMs = expectedFrameIntervalMs * (maxMissedFrames + 1);

    const result = [];
    const gaps = [];
    let videoOffsetMs = 0;

    for (let i = 0; i < frames.length; i++) {
        const cur = frames[i];
        const next = frames[i + 1];
        let durationMs;
        if (next) {
            const realGap = Number(next.ts) - Number(cur.ts);
            const isConnectionGap = realGap > gapThresholdMs;
            durationMs = isConnectionGap ? Math.min(realGap, maxGapMs) : realGap;
            // Если пропущено больше maxMissedFrames кадров — это пропуск связи.
            // Последний доставленный кадр всё равно показываем хотя бы один
            // обычный frame tick, а оставшуюся сжатую паузу помечаем как gap.
            if (isConnectionGap) {
                const gapStartMs = videoOffsetMs + Math.min(defaultDurationMs, durationMs);
                gaps.push({
                    startMs: gapStartMs,
                    endMs: videoOffsetMs + durationMs,
                    realDurationMs: realGap,
                });
            }
        } else {
            // Последний кадр.
            durationMs = defaultDurationMs;
        }
        // Защита от слишком коротких кадров (если клиент засыпал лимит).
        if (durationMs < defaultDurationMs) durationMs = defaultDurationMs;

        result.push({
            ts: Number(cur.ts),
            filePath: cur.filePath,
            videoOffsetMs,
            durationMs,
        });
        videoOffsetMs += durationMs;
    }

    return {
        frames: result,
        totalDurationMs: videoOffsetMs,
        gaps,
    };
}

/**
 * Строит filelist.txt для ffmpeg concat-демультиплексора.
 * Формат: file '<absolute path>' \n duration <seconds>
 *
 * NB: путь экранируем заменой ' на '\''.
 */
function buildFileListContent(timeline) {
    const lines = [];
    for (const f of timeline.frames) {
        const abs = path.join(RECORDINGS_DIR, f.filePath);
        const escaped = abs.replace(/'/g, "'\\''");
        lines.push(`file '${escaped}'`);
        lines.push(`duration ${(f.durationMs / 1000).toFixed(3)}`);
    }
    // По требованиям ffmpeg concat: последний кадр дублируется без duration,
    // чтобы duration предыдущего применился.
    if (timeline.frames.length) {
        const last = timeline.frames[timeline.frames.length - 1];
        const abs = path.join(RECORDINGS_DIR, last.filePath);
        const escaped = abs.replace(/'/g, "'\\''");
        lines.push(`file '${escaped}'`);
    }
    return lines.join('\n');
}

function runFfmpeg(args, cwd, onProgress) {
    return new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        const parser = createProgressParser(onProgress);
        proc.stderr.on('data', (chunk) => {
            const s = chunk.toString('utf8');
            // Берём только последние ~16KB на случай большого вывода.
            stderr = (stderr + s).slice(-16384);
            parser.feed(s);
        });
        proc.on('error', (err) => reject(err));
        proc.on('close', (code) => {
            if (code === 0) resolve({ code, stderr });
            else {
                const err = new Error(`ffmpeg exited with code ${code}`);
                err.stderr = stderr;
                reject(err);
            }
        });
    });
}

/**
 * Стейтфул-парсер прогресса ffmpeg. ffmpeg обычно пишет прогресс в одну
 * строку с \r вместо \n, обновляя её на месте. Разделяем по \r или \n.
 *
 * Каждый "frame= N" прогоняется через onProgress(N) — вызывающий сам
 * решает, нужно ли троттлить.
 *
 * Экспортируем для тестов.
 */
function createProgressParser(onProgress) {
    let buf = '';
    return {
        feed(chunk) {
            buf += chunk;
            const parts = buf.split(/\r|\n/);
            buf = parts.pop() || '';
            if (!onProgress) return;
            for (const line of parts) {
                const m = line.match(/frame=\s*(\d+)/);
                if (m) onProgress(Number(m[1]));
            }
            // Также проверим неполный буфер — ffmpeg часто заканчивает
            // строкой без \r/\n.
            const m2 = buf.match(/frame=\s*(\d+)/);
            if (m2) onProgress(Number(m2[1]));
        },
    };
}

/**
 * Главная функция: конвертирует все кадры participant в видео.
 * Идемпотентна: обновляет существующий Recording.
 */
async function convertParticipant(participantId) {
    const participant = await Participant.findByPk(participantId, {
        include: [{ model: Exam, as: 'exam', attributes: ['captureInterval'] }],
    });
    if (!participant) {
        const err = new Error('participant not found');
        err.status = 404;
        throw err;
    }

    const frames = await Frame.findAll({
        where: { participantId },
        order: [['ts', 'ASC']],
        attributes: ['ts', 'filePath'],
    });

    if (frames.length === 0) {
        const err = new Error('no frames to convert');
        err.status = 400;
        throw err;
    }

    // Найдём или создадим Recording.
    let recording = await Recording.findOne({ where: { participantId } });
    if (!recording) {
        recording = await Recording.create({
            participantId,
            status: Recording.STATUS.RUNNING,
            startedAt: new Date(),
            fps: config.video.fps,
            format: config.video.format,
        });
    } else {
        recording.status = Recording.STATUS.RUNNING;
        recording.startedAt = new Date();
        recording.errorMessage = null;
        recording.fps = config.video.fps;
        recording.format = config.video.format;
        await recording.save();
    }

    // Уведомляем UI.
    bus.emit('recording:status', {
        examId: participant.examId,
        participantId,
        status: recording.status,
        recordingId: recording.id,
    });

    const timeline = buildTimeline(frames, {
        expectedFrameIntervalMs:
            participant.exam?.captureInterval ?? participant.exam?.capture_interval,
    });

    // Готовим директорию для вывода.
    const participantDir = path.join(
        RECORDINGS_DIR,
        `exam_${participant.examId}`,
        `participant_${participantId}`
    );
    await fs.mkdir(participantDir, { recursive: true });

    const listFile = path.join(participantDir, 'concat.txt');
    const outputFileName = `recording.${config.video.format}`;
    const outputAbs = path.join(participantDir, outputFileName);
    const outputRel = path.posix.join(
        `exam_${participant.examId}`,
        `participant_${participantId}`,
        outputFileName
    );

    // Запишем concat-список.
    await fs.writeFile(listFile, buildFileListContent(timeline), 'utf8');

    // Сохраним таймлайн в JSON для плеера (этап 8).
    const timelineFile = path.join(participantDir, 'timeline.json');
    await fs.writeFile(
        timelineFile,
        JSON.stringify(
            {
                fps: config.video.fps,
                format: config.video.format,
                maxGapSeconds: config.video.maxGapSeconds,
                expectedFrameIntervalMs:
                    participant.exam?.captureInterval ?? participant.exam?.capture_interval ?? null,
                maxMissedFrames: 3,
                totalDurationMs: timeline.totalDurationMs,
                frameCount: timeline.frames.length,
                firstFrameTs: timeline.frames[0].ts,
                lastFrameTs: timeline.frames[timeline.frames.length - 1].ts,
                gaps: timeline.gaps,
                // Сами кадры можно отдавать большие — ужмём до { ts, vo } для размера.
                frames: timeline.frames.map((f) => ({
                    ts: f.ts,
                    vo: f.videoOffsetMs,
                    d: f.durationMs,
                })),
            },
            null,
            0
        )
    );

    // Запуск ffmpeg.
    const args = [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listFile,
        '-vsync',
        'vfr',
        '-pix_fmt',
        'yuv420p',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '26',
        '-movflags',
        '+faststart',
        outputAbs,
    ];

    logger.info(
        { participantId, frames: frames.length, durationMs: timeline.totalDurationMs },
        'ffmpeg start'
    );

    try {
        // Прогресс-throttle: эмитим максимум раз в 500мс, чтобы не флудить.
        // ffmpeg concat дублирует последний кадр без duration, поэтому реальное
        // количество "frame=N" будет на 1 больше, чем кадров — учитываем.
        const totalFrames = timeline.frames.length + 1;
        let lastEmittedAt = 0;
        let lastFrame = 0;
        await runFfmpeg(args, participantDir, (frame) => {
            if (frame <= lastFrame) return;
            lastFrame = frame;
            const now = Date.now();
            if (now - lastEmittedAt < 500 && frame < totalFrames) return;
            lastEmittedAt = now;
            bus.emit('recording:progress', {
                examId: participant.examId,
                participantId,
                processedFrames: Math.min(frame, totalFrames),
                totalFrames,
                percent: totalFrames ? Math.min(100, Math.round((frame / totalFrames) * 100)) : 0,
            });
        });
    } catch (err) {
        recording.status = Recording.STATUS.FAILED;
        recording.errorMessage = err.message + (err.stderr ? '\n' + err.stderr.slice(-2000) : '');
        recording.finishedAt = new Date();
        await recording.save();
        bus.emit('recording:status', {
            examId: participant.examId,
            participantId,
            status: recording.status,
            error: 'ffmpeg failed',
        });
        // Удаляем concat-файл.
        await fs.unlink(listFile).catch(() => {});
        throw err;
    }

    // Удаляем concat — он не нужен.
    await fs.unlink(listFile).catch(() => {});

    let stat;
    try {
        stat = await fs.stat(outputAbs);
    } catch (err) {
        recording.status = Recording.STATUS.FAILED;
        recording.errorMessage = 'output file not found after ffmpeg: ' + err.message;
        recording.finishedAt = new Date();
        await recording.save();
        throw err;
    }

    recording.status = Recording.STATUS.DONE;
    recording.filePath = outputRel;
    recording.fps = config.video.fps;
    recording.format = config.video.format;
    recording.durationMs = timeline.totalDurationMs;
    recording.sizeBytes = stat.size;
    recording.finishedAt = new Date();
    await recording.save();

    logger.info(
        { participantId, durationMs: timeline.totalDurationMs, sizeBytes: stat.size },
        'ffmpeg done'
    );

    bus.emit('recording:status', {
        examId: participant.examId,
        participantId,
        status: recording.status,
        recordingId: recording.id,
        durationMs: timeline.totalDurationMs,
    });

    return recording;
}

/**
 * Помещает participantId в очередь конвертации.
 * Возвращает promise, который зарезолвится когда задача обработается.
 */
async function enqueueConvert(participantId) {
    if (inProgress.has(participantId)) {
        logger.info({ participantId }, 'already in progress, skip enqueue');
        return;
    }
    if (queue.find((q) => q.participantId === participantId)) {
        logger.info({ participantId }, 'already queued, skip enqueue');
        return;
    }

    // Найдём examId сразу, чтобы pending-уведомление шло в правильную комнату.
    const participant = await Participant.findByPk(participantId, {
        attributes: ['id', 'examId'],
    });
    if (!participant) {
        const err = new Error('participant not found');
        err.status = 404;
        throw err;
    }

    return new Promise((resolve, reject) => {
        queue.push({ participantId, resolve, reject });
        bus.emit('recording:status', {
            examId: participant.examId,
            participantId,
            status: 'pending',
        });
        pumpQueue();
    });
}

function pumpQueue() {
    while (activeWorkers < config.video.concurrency && queue.length > 0) {
        const job = queue.shift();
        activeWorkers++;
        inProgress.add(job.participantId);
        runJob(job).finally(() => {
            activeWorkers--;
            inProgress.delete(job.participantId);
            pumpQueue();
        });
    }
}

async function runJob(job) {
    try {
        const recording = await convertParticipant(job.participantId);
        job.resolve(recording);
    } catch (err) {
        logger.error({ err: err.message, participantId: job.participantId }, 'conversion failed');
        job.reject(err);
    }
}

/**
 * Возвращает текущий статус для UI.
 */
function getQueueState() {
    return {
        active: activeWorkers,
        queued: queue.length,
        inProgress: [...inProgress],
    };
}

module.exports = {
    enqueueConvert,
    convertParticipant, // для тестов / прямого вызова
    buildTimeline, // экспортирую — пригодится на этапе 8 если нет recording.json
    createProgressParser, // для тестов
    getQueueState,
};
