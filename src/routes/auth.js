'use strict';

const express = require('express');
const config = require('../config');
const usersService = require('../services/users');
const geekclassService = require('../services/geekclass');
const logger = require('../logger');

const router = express.Router();

// Безопасный редирект — только относительные пути в рамках нашего домена,
// чтобы ?next=... нельзя было использовать для open redirect.
function safeNext(input, fallback = '/admin') {
    if (!input || typeof input !== 'string') return fallback;
    if (!input.startsWith('/') || input.startsWith('//')) return fallback;
    return input;
}

router.get('/login', (req, res) => {
    if (req.user) {
        return res.redirect(safeNext(req.query.next, '/admin'));
    }
    res.renderPage('admin/login', {
        title: 'Вход',
        next: safeNext(req.query.next, '/admin'),
        error: req.query.error || null,
        geekclassEnabled: config.geekclass.enabled,
    });
});

router.post(
    '/login',
    express.urlencoded({ extended: false, limit: '4kb' }),
    async (req, res, next) => {
        try {
            const login = String(req.body.login || '').trim();
            const password = String(req.body.password || '');
            const next_ = safeNext(req.body.next, '/admin');

            if (!login || !password) {
                return res.redirect(`/auth/login?next=${encodeURIComponent(next_)}&error=empty`);
            }

            const user = await usersService.authenticateLocal(login, password);
            if (!user) {
                req.log.info({ login }, 'login failed');
                return res.redirect(`/auth/login?next=${encodeURIComponent(next_)}&error=invalid`);
            }

            // Регенерация SID после логина — защита от session fixation.
            req.session.regenerate((err) => {
                if (err) return next(err);
                req.session.userId = user.id;
                req.session.save((err2) => {
                    if (err2) return next(err2);
                    req.log.info({ userId: user.id, login: user.login }, 'login ok');
                    res.redirect(next_);
                });
            });
        } catch (err) {
            next(err);
        }
    }
);

router.get('/logout', (req, res, next) => {
    if (!req.session) {
        return res.redirect('/');
    }
    req.session.destroy((err) => {
        if (err) return next(err);
        res.clearCookie('cs.sid');
        res.redirect('/');
    });
});

// ---------------- GeekClass ----------------
if (config.geekclass.enabled) {
    router.get('/geekclass', (req, res) => {
        const next_ = safeNext(req.query.next, '/admin');
        const callback = `${config.publicUrl}/auth/geekclass/callback?next=${encodeURIComponent(next_)}`;
        const url = geekclassService.buildLoginUrl(callback);
        res.redirect(url);
    });

    router.get('/geekclass/callback', async (req, res, next) => {
        try {
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
                logger.warn({ err: err.message }, 'geekclass jwt invalid');
                return res.status(403).renderPage('error', {
                    title: 'Ошибка авторизации',
                    message: 'Токен GeekClass невалиден или устарел',
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
}

module.exports = router;
