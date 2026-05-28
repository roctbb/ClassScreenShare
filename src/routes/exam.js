'use strict';

const express = require('express');
const { z } = require('zod');
const examsService = require('../services/exams');
const participantsService = require('../services/participants');
const { normalizeExamCode } = require('../lib/util');

const router = express.Router();

const PARTICIPANT_COOKIE = 'cs.participant';

const joinSchema = z.object({
    name: z
        .string()
        .trim()
        .min(1, 'name is required')
        .max(120, 'name is too long')
        // Запрещаем управляющие символы — это намеренный фильтр.
        // eslint-disable-next-line no-control-regex
        .regex(/^[^\u0000-\u001F\u007F]+$/, 'name contains invalid characters'),
});

function setParticipantCookie(res, token) {
    res.cookie(PARTICIPANT_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        // session-scoped (закрытие браузера = удаление). При перезагрузке вкладки
        // сохраняется, а это всё что нам нужно для reconnect.
        secure: false, // ставится сервером в любом случае только под httpOnly
        path: '/',
    });
}

function codeFromInput(input) {
    const raw = String(input || '').trim();
    if (!raw) return '';
    try {
        const url = new URL(raw);
        return normalizeExamCode(url.pathname.split('/').filter(Boolean).pop() || '');
    } catch {
        return normalizeExamCode(raw);
    }
}

// Промежуточный лог-helper, чтобы admin/exam ссылка отрабатывалась только
// для активных экзаменов.
async function loadActiveExam(req, res, next) {
    const code = String(req.params.code || '').toUpperCase();
    const exam = await examsService.getExamByCode(code);
    if (!exam) {
        return res.status(404).renderPage('error', {
            title: 'Экзамен не найден',
            message: 'Проверьте код экзамена.',
        });
    }
    if (exam.status !== 'active') {
        return res.status(403).renderPage('error', {
            title: 'Экзамен недоступен',
            message:
                exam.status === 'finished'
                    ? 'Этот экзамен уже завершён.'
                    : 'Экзамен ещё не запущен. Попробуйте подключиться позже.',
        });
    }
    req.exam = exam;
    next();
}

router.get('/exam', (req, res) => {
    try {
        const code = codeFromInput(req.query.code);
        if (!code) return res.redirect('/');
        return res.redirect(`/exam/${encodeURIComponent(code)}`);
    } catch {
        return res.redirect('/?error=bad_code');
    }
});

// Страница участника: форма имени, после сабмита — захват экрана.
router.get('/exam/:code', loadActiveExam, async (req, res, next) => {
    try {
        const exam = req.exam;
        const token = req.cookies[PARTICIPANT_COOKIE] || null;
        let participant = null;
        if (token) {
            participant = await participantsService.findByToken(exam.id, token);
        }

        res.renderPage('exam/index', {
            title: exam.name,
            exam: exam.toJSON(),
            participant: participant ? participant.toJSON() : null,
            captureInterval: exam.captureInterval,
            imageQuality: exam.imageQuality,
            imageWidth: exam.imageWidth,
        });
    } catch (err) {
        next(err);
    }
});

// API: участник вводит имя (или возвращается в свою сессию), мы создаём/обновляем
// participant и ставим cookie. Отвечает JSON, чтобы фронт мог обработать ошибки.
router.post('/api/exam/:code/join', loadActiveExam, async (req, res, next) => {
    try {
        const exam = req.exam;
        const parsed = joinSchema.safeParse(req.body || {});
        if (!parsed.success) {
            return res.status(400).json({
                ok: false,
                error: parsed.error.issues[0]?.message || 'invalid input',
            });
        }
        const name = parsed.data.name;
        const existingToken = req.cookies[PARTICIPANT_COOKIE] || null;

        const ip =
            (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
            req.socket.remoteAddress ||
            null;

        const { participant, resumed } = await participantsService.joinOrResume({
            examId: exam.id,
            name,
            token: existingToken,
            ip,
            userAgent: req.headers['user-agent'],
        });

        setParticipantCookie(res, participant.token);

        res.json({
            ok: true,
            resumed,
            participant: {
                id: participant.id,
                name: participant.name,
            },
            exam: {
                code: exam.code,
                name: exam.name,
                captureInterval: exam.captureInterval,
                imageQuality: exam.imageQuality,
                imageWidth: exam.imageWidth,
            },
        });
    } catch (err) {
        if (err.status === 400) {
            return res.status(400).json({ ok: false, error: err.message });
        }
        next(err);
    }
});

// API: участник нажал "Завершить".
router.post('/api/exam/:code/leave', loadActiveExam, async (req, res, next) => {
    try {
        const exam = req.exam;
        const token = req.cookies[PARTICIPANT_COOKIE];
        if (!token) {
            return res.status(400).json({ ok: false, error: 'no_token' });
        }
        const participant = await participantsService.findByToken(exam.id, token);
        if (!participant) {
            return res.status(404).json({ ok: false, error: 'not_found' });
        }
        await participantsService.leave(participant.id);
        res.clearCookie(PARTICIPANT_COOKIE);
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

module.exports = { router, PARTICIPANT_COOKIE };
