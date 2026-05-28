'use strict';

const express = require('express');
const config = require('../config');
const examsService = require('../services/exams');
const geekclassService = require('../services/geekclass');
const participantsService = require('../services/participants');
const { normalizeExamCode } = require('../lib/util');

const router = express.Router();

// Cookie больше не используется для auth участника — только для хранения examCode после GeekClass.
const EXAM_COOKIE = 'cs.exam';

function setExamCookie(res, code) {
    res.cookie(EXAM_COOKIE, code, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 1000, // 1 час
    });
}

function requestIp(req) {
    return (
        (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
        req.socket.remoteAddress ||
        null
    );
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

// Редирект /exam?code=XXX → /exam/XXX
router.get('/exam', (req, res) => {
    try {
        const code = codeFromInput(req.query.code);
        if (!code) return res.redirect('/');
        return res.redirect(`/exam/${encodeURIComponent(code)}`);
    } catch {
        return res.redirect('/?error=bad_code');
    }
});

// Страница участника: если уже авторизован — показываем сразу, иначе → GeekClass.
router.get('/exam/:code', loadActiveExam, async (req, res, next) => {
    try {
        const pid = Number(req.cookies['cs.participant.pid']);
        if (pid) {
            const participant = await participantsService.findByGeekclassId(
                req.exam.id,
                req.cookies['cs.participant.gc']
            );
            if (participant) {
                return res.renderPage('exam/index', {
                    title: req.exam.name,
                    exam: req.exam.toJSON(),
                    participant: participant.toJSON(),
                    captureInterval: req.exam.captureInterval,
                    imageQuality: req.exam.imageQuality,
                    imageWidth: req.exam.imageWidth,
                });
            }
        }
        if (!config.geekclass.enabled) {
            return res.status(503).renderPage('error', {
                title: 'GeekClass недоступен',
                message: 'Для участия в экзамене необходима авторизация через GeekClass.',
            });
        }
        setExamCookie(res, req.exam.code);
        const callback = `${config.publicUrl}/exam/${req.exam.code}/geekclass/callback`;
        return res.redirect(geekclassService.buildLoginUrl(callback));
    } catch (err) {
        next(err);
    }
});

// GeekClass callback для участника.
router.get('/exam/:code/geekclass/callback', loadActiveExam, async (req, res, next) => {
    try {
        if (!config.geekclass.enabled) {
            return res.status(503).renderPage('error', {
                title: 'GeekClass недоступен',
                message: 'Авторизация через GeekClass не настроена.',
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

        // Имя участника из JWT.
        const name = extractName(payload);

        const { participant } = await participantsService.joinOrResume({
            examId: req.exam.id,
            name,
            geekclassId: String(payload.id),
            ip: requestIp(req),
            userAgent: req.headers['user-agent'],
        });

        // Сохраняем geekclass_id в сессии участника (в cookie) для handshake publisher.
        res.cookie('cs.participant.gc', String(payload.id), {
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
            maxAge: 24 * 60 * 60 * 1000,
        });
        res.cookie('cs.participant.pid', String(participant.id), {
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
            maxAge: 24 * 60 * 60 * 1000,
        });

        return res.renderPage('exam/index', {
            title: req.exam.name,
            exam: req.exam.toJSON(),
            participant: participant.toJSON(),
            captureInterval: req.exam.captureInterval,
            imageQuality: req.exam.imageQuality,
            imageWidth: req.exam.imageWidth,
        });
    } catch (err) {
        if (err.status === 400) {
            return res.status(400).renderPage('error', {
                title: 'Ошибка',
                message: err.message,
            });
        }
        next(err);
    }
});

// API: участник нажал "Завершить".
router.post('/api/exam/:code/leave', loadActiveExam, async (req, res, next) => {
    try {
        const pid = Number(req.cookies['cs.participant.pid']);
        const gc = req.cookies['cs.participant.gc'];
        if (!pid || !gc) return res.status(400).json({ ok: false, error: 'no_session' });

        const participant = await participantsService.findByGeekclassId(req.exam.id, gc);
        if (!participant) return res.status(404).json({ ok: false, error: 'not_found' });

        // Проверка целостности cookie: pid должен соответствовать participant найденному по gc.
        if (participant.id !== pid) {
            return res.status(403).json({ ok: false, error: 'cookie_mismatch' });
        }
        await participantsService.leave(participant.id);
        res.clearCookie('cs.participant.gc');
        res.clearCookie('cs.participant.pid');
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

function extractName(payload) {
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
        const name = String(value || '').trim().slice(0, 120);
        if (name) return name;
    }
    return `GeekClass ${payload.id}`;
}

module.exports = { router, EXAM_COOKIE };
