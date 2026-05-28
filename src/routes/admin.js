'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const examsService = require('../services/exams');
const participantConnectionsService = require('../services/participantConnections');
const config = require('../config');

const router = express.Router();

router.use(requireAuth);

// Список экзаменов.
router.get('/', async (req, res, next) => {
    try {
        const exams = await examsService.listExams();
        res.renderPage('admin/index', {
            title: 'Экзамены',
            exams: exams.map((e) => e.toJSON()),
            createError: req.query.error || null,
        });
    } catch (err) {
        next(err);
    }
});

// Создать экзамен.
router.post('/exams', async (req, res, next) => {
    try {
        const name = String(req.body.name || '').trim();
        if (!name) {
            return res.redirect('/admin?error=empty');
        }
        const code = String(req.body.code || '').trim();
        const exam = await examsService.createExam({
            name,
            code,
            createdBy: req.user.id,
        });
        req.log.info({ examId: exam.id, code: exam.code }, 'exam created');
        return res.redirect(`/admin/exams/${exam.id}`);
    } catch (err) {
        if (err.status === 400) {
            return res.redirect(
                '/admin?error=' + (err.message.includes('code') ? 'bad_code' : 'invalid')
            );
        }
        if (err.status === 409) {
            return res.redirect('/admin?error=code_exists');
        }
        next(err);
    }
});

// Карточка экзамена (объединяет список участников и live-мониторинг).
router.get('/exams/:id(\\d+)', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const exam = await examsService.getExamById(id);
        if (!exam) return next();

        const participants = await examsService.listParticipants(id);

        // Загружаем логи подключений всех участников одним запросом.
        const logsByParticipant = await participantConnectionsService.listForExam(id);
        const absenceMap = {};
        for (const p of participants) {
            const logs = logsByParticipant.get(p.id) || [];
            const timeline = participantConnectionsService.buildConnectionSessions(
                logs.map((l) => l.toJSON())
            );
            absenceMap[p.id] = timeline.summary.totalAbsenceLabel;
        }

        res.renderPage('admin/exam', {
            title: `Экзамен: ${exam.name}`,
            exam: exam.toJSON(),
            participants: participants.map((p) => ({
                ...p.toJSON(),
                absenceLabel: absenceMap[p.id] || '—',
            })),
            inviteUrl: `${config.publicUrl}/exam/${exam.code}`,
            renamed: req.query.renamed === '1',
            inactivityTimeout: config.inactivityTimeout,
        });
    } catch (err) {
        next(err);
    }
});

// Постоянный редирект со старого live-URL на объединённую страницу.
router.get('/exams/:id(\\d+)/live', (req, res) => {
    res.redirect(301, `/admin/exams/${req.params.id}`);
});

// Экспорт участников в CSV.
router.get('/exams/:id(\\d+)/participants.csv', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const exam = await examsService.getExamById(id);
        if (!exam) return next();
        const participants = await examsService.listParticipants(id);

        const fmt = (s) => {
            if (s === null || s === undefined) return '';
            const str = String(s);
            if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
            return str;
        };
        const fmtTs = (ts) => (ts ? new Date(Number(ts)).toISOString() : '');

        const lines = [
            [
                'id',
                'name',
                'joined_at',
                'last_seen_at',
                'frames',
                'first_frame',
                'last_frame',
                'recording_status',
            ]
                .map(fmt)
                .join(','),
        ];
        for (const p of participants) {
            const data = p.toJSON();
            lines.push(
                [
                    data.id,
                    data.name,
                    data.joined_at ? new Date(data.joined_at).toISOString() : '',
                    data.last_seen_at ? new Date(data.last_seen_at).toISOString() : '',
                    data.frameCount || 0,
                    fmtTs(data.firstFrameTs),
                    fmtTs(data.lastFrameTs),
                    data.recording ? data.recording.status : '',
                ]
                    .map(fmt)
                    .join(',')
            );
        }
        // \uFEFF для Excel UTF-8 detection.
        const csv = '\uFEFF' + lines.join('\r\n') + '\r\n';
        const safeExamName = exam.name.replace(/[^a-zA-Zа-яА-ЯёЁ0-9_-]/g, '_').slice(0, 80);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename*=UTF-8''${encodeURIComponent(safeExamName)}-participants.csv`
        );
        res.send(csv);
    } catch (err) {
        next(err);
    }
});

// Переименовать.
router.post('/exams/:id(\\d+)/rename', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const name = String(req.body.name || '').trim();
        if (!name) {
            return res.redirect(`/admin/exams/${id}`);
        }
        const exam = await examsService.renameExam(id, name);
        if (!exam) return next();
        req.log.info({ examId: id }, 'exam renamed');
        return res.redirect(`/admin/exams/${id}?renamed=1`);
    } catch (err) {
        next(err);
    }
});

// Старт экзамена (draft → active).
router.post('/exams/:id(\\d+)/activate', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const exam = await examsService.activateExam(id);
        if (!exam) return next();
        req.log.info({ examId: id }, 'exam activated');
        return res.redirect(`/admin/exams/${id}`);
    } catch (err) {
        if (err.status === 400) {
            return res.redirect(`/admin/exams/${req.params.id}`);
        }
        next(err);
    }
});

// Завершить экзамен (active → finished).
router.post('/exams/:id(\\d+)/finish', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const exam = await examsService.finishExam(id);
        if (!exam) return next();
        req.log.info({ examId: id }, 'exam finished');
        return res.redirect(`/admin/exams/${id}`);
    } catch (err) {
        next(err);
    }
});

// Удалить экзамен.
router.post('/exams/:id(\\d+)/delete', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const ok = await examsService.deleteExam(id);
        if (!ok) return next();
        req.log.info({ examId: id }, 'exam deleted');
        return res.redirect('/admin');
    } catch (err) {
        next(err);
    }
});

// ---------------- Recordings ----------------

const fs = require('fs/promises');
const fsSync = require('fs');
const pathMod = require('path');
const videoService = require('../services/video');
const { Participant, Frame, Recording } = require('../db/models');

// Страница участника с плеером.
router.get('/exams/:examId(\\d+)/participants/:pid(\\d+)', async (req, res, next) => {
    try {
        const examId = Number(req.params.examId);
        const pid = Number(req.params.pid);
        const participant = await Participant.findOne({
            where: { id: pid, examId },
            include: [{ model: Recording, as: 'recording', required: false }],
        });
        if (!participant) return next();
        const exam = await examsService.getExamById(examId);
        if (!exam) return next();

        const frameCount = await Frame.count({ where: { participantId: pid } });
        const connectionLogs = await participantConnectionsService.listForParticipant(pid, {
            limit: 500,
        });
        const connectionTimeline = participantConnectionsService.buildConnectionSessions(
            connectionLogs.map((log) => log.toJSON())
        );
        const connectionEvents = connectionLogs
            .map((log) => {
                const event = participantConnectionsService.serializeLiveEvent(log, {
                    participantId: participant.id,
                    name: participant.name,
                });
                return event ? { event: event.event, createdAt: event.createdAt } : null;
            })
            .filter(Boolean);

        res.renderPage('admin/participant', {
            title: `${participant.name} — ${exam.name}`,
            exam: exam.toJSON(),
            participant: participant.toJSON(),
            recording: participant.recording ? participant.recording.toJSON() : null,
            frameCount,
            connectionSessions: connectionTimeline.sessions,
            connectionSummary: connectionTimeline.summary,
            connectionEvents,
            maxGapSeconds: config.video.maxGapSeconds,
        });
    } catch (err) {
        next(err);
    }
});

// Запустить конвертацию для участника.
router.post('/exams/:examId(\\d+)/participants/:pid(\\d+)/convert', async (req, res, next) => {
    try {
        const examId = Number(req.params.examId);
        const pid = Number(req.params.pid);
        const participant = await Participant.findOne({ where: { id: pid, examId } });
        if (!participant) return next();

        // Запускаем в фоне; UI получит уведомление через socket.
        videoService.enqueueConvert(pid).catch((err) => {
            req.log.error({ err: err.message, pid }, 'convert failed');
        });
        if (req.headers.accept && req.headers.accept.includes('application/json')) {
            return res.json({ ok: true });
        }
        return res.redirect(`/admin/exams/${examId}/participants/${pid}`);
    } catch (err) {
        next(err);
    }
});

// Удалить участника.
router.post('/exams/:examId(\\d+)/participants/:pid(\\d+)/delete', async (req, res, next) => {
    try {
        const examId = Number(req.params.examId);
        const pid = Number(req.params.pid);
        const participant = await Participant.findOne({ where: { id: pid, examId } });
        if (!participant) return next();
        await examsService.deleteParticipant(pid);
        req.log.info({ participantId: pid, examId }, 'participant deleted');
        return res.redirect(`/admin/exams/${examId}`);
    } catch (err) {
        next(err);
    }
});

// Запустить конвертацию для всего экзамена.
router.post('/exams/:id(\\d+)/convert-all', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const exam = await examsService.getExamById(id);
        if (!exam) return next();
        const participants = await Participant.findAll({
            where: { examId: id },
            attributes: ['id'],
        });
        for (const p of participants) {
            videoService.enqueueConvert(p.id).catch(() => {});
        }
        if (req.headers.accept && req.headers.accept.includes('application/json')) {
            return res.json({ ok: true, queued: participants.length });
        }
        return res.redirect(`/admin/exams/${id}`);
    } catch (err) {
        next(err);
    }
});

// ---------------- API for player ----------------

// Стрим recording.mp4. Express sendFile поддерживает Range из коробки.
router.get('/api/recordings/:id(\\d+)/video', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const recording = await Recording.findByPk(id, {
            include: [
                { model: Participant, as: 'participant', attributes: ['id', 'name', 'examId'] },
            ],
        });
        if (!recording || recording.status !== 'done' || !recording.filePath) {
            return res.status(404).json({ error: 'not_ready' });
        }
        const abs = pathMod.join(config.recordingsDir, recording.filePath);
        const resolved = pathMod.resolve(abs);
        if (!resolved.startsWith(pathMod.resolve(config.recordingsDir))) {
            return res.status(403).json({ error: 'forbidden' });
        }
        // Если запрос с ?download=1 — добавляем Content-Disposition.
        if (req.query.download === '1' && recording.participant) {
            const safeName = recording.participant.name
                .replace(/[^a-zA-Zа-яА-ЯёЁ0-9_ -]/g, '_')
                .slice(0, 80);
            const filename = `${safeName} (#${recording.participant.id}).${recording.format}`;
            res.setHeader(
                'Content-Disposition',
                `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
            );
        }
        res.sendFile(resolved, { acceptRanges: true });
    } catch (err) {
        next(err);
    }
});

// Таймлайн в JSON (читается из timeline.json рядом с видео).
router.get('/api/recordings/:id(\\d+)/timeline', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const recording = await Recording.findByPk(id);
        if (!recording || !recording.filePath) {
            return res.status(404).json({ error: 'not_found' });
        }
        const dir = pathMod.dirname(pathMod.join(config.recordingsDir, recording.filePath));
        const tlFile = pathMod.join(dir, 'timeline.json');
        if (!fsSync.existsSync(tlFile)) {
            return res.status(404).json({ error: 'no_timeline' });
        }
        const json = await fs.readFile(tlFile, 'utf8');
        res.type('application/json').send(json);
    } catch (err) {
        next(err);
    }
});

// Список кадров участника (для slideshow-fallback).
router.get('/api/participants/:pid(\\d+)/frames', async (req, res, next) => {
    try {
        const pid = Number(req.params.pid);
        const frames = await Frame.findAll({
            where: { participantId: pid },
            order: [['ts', 'ASC']],
            attributes: ['id', 'ts', 'sizeBytes'],
        });
        res.json({
            count: frames.length,
            frames: frames.map((f) => ({ id: f.id, ts: Number(f.ts), size: f.sizeBytes })),
        });
    } catch (err) {
        next(err);
    }
});

// Один кадр по id (для slideshow).
router.get('/api/frames/:id(\\d+)', async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        const frame = await Frame.findByPk(id, { attributes: ['filePath'] });
        if (!frame) return res.status(404).json({ error: 'not_found' });
        const abs = pathMod.join(config.recordingsDir, frame.filePath);
        const resolved = pathMod.resolve(abs);
        if (!resolved.startsWith(pathMod.resolve(config.recordingsDir))) {
            return res.status(403).json({ error: 'forbidden' });
        }
        // Кэшим — кадр иммутабельный.
        res.set('Cache-Control', 'private, max-age=86400, immutable');
        res.sendFile(resolved);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
