'use strict';

const express = require('express');
const config = require('../config');
const geekclassService = require('../services/geekclass');
const logger = require('../logger');

const router = express.Router();

function safeNext(input, fallback = '/admin') {
    if (!input || typeof input !== 'string') return fallback;
    if (!input.startsWith('/') || input.startsWith('//')) return fallback;
    return input;
}

router.get('/login', (req, res) => {
    if (req.user) {
        return res.redirect(safeNext(req.query.next, '/admin'));
    }
    if (!config.geekclass.enabled) {
        return res.status(503).renderPage('error', {
            title: 'Авторизация недоступна',
            message: 'GeekClass не настроен. Задайте GEEKCLASS_HOST и GEEKCLASS_JWT_SECRET.',
        });
    }
    const next_ = safeNext(req.query.next, '/admin');
    const callback = `${config.publicUrl}/auth/geekclass/callback?next=${encodeURIComponent(next_)}`;
    return res.redirect(geekclassService.buildLoginUrl(callback));
});

router.get('/logout', (req, res, next) => {
    if (!req.session) return res.redirect('/');
    req.session.destroy((err) => {
        if (err) return next(err);
        res.clearCookie('cs.sid');
        res.redirect('/');
    });
});

router.get('/geekclass', (req, res) => {
    if (!config.geekclass.enabled) {
        return res.status(503).renderPage('error', {
            title: 'GeekClass недоступен',
            message: 'Вход через GeekClass не настроен.',
        });
    }
    const next_ = safeNext(req.query.next, '/admin');
    const callback = `${config.publicUrl}/auth/geekclass/callback?next=${encodeURIComponent(next_)}`;
    return res.redirect(geekclassService.buildLoginUrl(callback));
});

router.get('/geekclass/callback', async (req, res, next) => {
    try {
        if (!config.geekclass.enabled) {
            return res.status(503).renderPage('error', {
                title: 'GeekClass недоступен',
                message: 'Вход через GeekClass не настроен.',
            });
        }
        const token = req.query.token;
        const next_ = safeNext(req.query.next, '/admin');
        if (!token || typeof token !== 'string') {
            return res.status(400).renderPage('error', {
                title: 'Ошибка авторизации',
                message: 'Не передан токен от GeekClass',
            });
        }
        let user;
        try {
            user = await geekclassService.loginByToken(token);
        } catch (err) {
            logger.warn({ err: err.message }, 'geekclass jwt invalid or access denied');
            const msg =
                err.status === 403
                    ? 'Доступ запрещён. Для входа в систему нужна роль учителя или администратора.'
                    : 'Токен GeekClass невалиден или устарел';
            return res.status(err.status || 403).renderPage('error', {
                title: 'Ошибка авторизации',
                message: msg,
            });
        }
        req.session.regenerate((err) => {
            if (err) return next(err);
            req.session.userId = user.id;
            req.session.save((err2) => {
                if (err2) return next(err2);
                req.log.info({ userId: user.id, provider: 'geekclass' }, 'login ok');
                res.redirect(next_);
            });
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
