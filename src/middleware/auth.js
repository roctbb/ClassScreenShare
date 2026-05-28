'use strict';

const { User } = require('../db/models');

/**
 * Загружает пользователя из сессии в req.user и res.locals.user.
 * Если пользователь удалён из БД — обнуляет сессию.
 * Не блокирует запрос; для блокировки используй requireAuth.
 */
async function loadUser(req, res, next) {
    try {
        const userId = req.session && req.session.userId;
        if (!userId) {
            req.user = null;
            res.locals.user = null;
            return next();
        }
        const user = await User.findByPk(userId);
        if (!user) {
            req.session.userId = null;
            req.user = null;
            res.locals.user = null;
            return next();
        }
        req.user = user;
        res.locals.user = {
            id: user.id,
            login: user.login,
            name: user.name,
            role: user.role,
            provider: user.provider,
        };
        next();
    } catch (err) {
        next(err);
    }
}

/**
 * Требует авторизованного пользователя с ролью teacher или admin.
 * Для HTML — редирект на /auth/login, для JSON-API — 401/403.
 */
function requireAuth(req, res, next) {
    const wantsJson =
        req.xhr ||
        (req.headers.accept && req.headers.accept.includes('application/json')) ||
        req.path.startsWith('/api/');

    if (!req.user) {
        if (wantsJson) return res.status(401).json({ error: 'unauthorized' });
        const next_ = encodeURIComponent(req.originalUrl || '/');
        return res.redirect(`/auth/login?next=${next_}`);
    }

    if (req.user.role !== 'teacher' && req.user.role !== 'admin') {
        if (wantsJson) return res.status(403).json({ error: 'forbidden' });
        return res.status(403).renderPage('error', {
            title: 'Доступ запрещён',
            message: 'Для доступа в админку нужна роль учителя или администратора.',
        });
    }

    return next();
}

module.exports = { loadUser, requireAuth };
