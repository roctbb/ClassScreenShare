'use strict';

const express = require('express');
const { z } = require('zod');
const config = require('../config');
const examsService = require('../services/exams');
const geekclassService = require('../services/geekclass');
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

function requestIp(req) {
    return (
        (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
        req.socket.remoteAddress ||
        null
    );
}

function participantNameFromGeekclass(payload) {
    const candidates = [
        payload.name,
        payload.full_name,
        payload.fullName,
        payload.username,
        payload.login,
        payload.email,
        typeof payload.id !== 'undefined' ? `GeekClass ${payload.id}` : null,
    ];
    for (const value of candidates) {
        const name = String(value || '').trim();
        if (!name) continue;
        const parsed = joinSchema.safeParse({ name: name.slice(0, 120) });
        if (parsed.success) return parsed.data.name;
    }
    const err = new Error('geekclass profile has no valid name');
    err.status = 400;
    throw err;
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

router.get('/exam/:code/geekclass', loadActiveExam, (req, res) => {
    if (!config.geekclass.enabled) {
        return res.status(404).renderPage('error', {
            title: 'GeekClass недоступен',
            message: 'Вход через GeekClass не настроен.',
        });
    }
    const callback = `${config.publicUrl}/exam/${req.exam.code}/geekclass/callback`;
    return res.redirect(geekclassService.buildLoginUrl(callback));
});

router.get('/exam/:code/geekclass/callback', loadActiveExam, async (req, res, next) => {
    try {
        if (!config.geekclass.enabled) {
            return res.status(404).renderPage('error', {
                title: 'GeekClass недоступен',
                message: 'Вход через GeekClass не настроен.',
            });
        }
        const token = req.query.token;
        if (!token || typeof token !== 'string') {
            return res.status(400).renderPage('error', {
                title: 'Ошибка авторизации',
                message: 'Не передан токен от GeekClass.',
            });
        }

        let payload;
        try {
            payload = geekclassService.verifyToken(token);
        } catch {
            return res.status(403).renderPage('error', {
                title: 'Ошибка авторизации',
                message: 'Токен GeekClass невалиден или устарел.',
            });
        }
        const name = participantNameFromGeekclass(payload);
        const existingToken = req.cookies[PARTICIPANT_COOKIE] || null;
        const { participant } = await participantsService.joinOrResume({
            examId: req.exam.id,
            name,
            token: existingToken,
            ip: requestIp(req),
            userAgent: req.headers['user-agent'],
        });
        setParticipantCookie(res, participant.token);
        return res.redirect(`/exam/${encodeURIComponent(req.exam.code)}`);
    } catch (err) {
        if (err.status === 400) {
            return res.status(400).renderPage('error', {
                title: 'Ошибка авторизации',
                message: err.message,
            });
        }
        next(err);
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
            geekclassEnabled: config.geekclass.enabled,
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

        const { participant, resumed } = await participantsService.joinOrResume({
            examId: exam.id,
            name,
            token: existingToken,
            ip: requestIp(req),
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
