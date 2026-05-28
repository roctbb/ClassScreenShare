'use strict';

const crypto = require('crypto');

/**
 * Лёгкая защита от CSRF на admin POST'ах.
 *
 * Подход: при первом GET-запросе с сессией кладём в req.session.csrf
 * случайный токен. На POST/PUT/DELETE с сессией — проверяем что переданный
 * токен совпадает (через body._csrf или заголовок X-CSRF-Token).
 *
 * SameSite=lax cookie защищает уже от 90% сценариев; CSRF-токен — второй
 * рубеж на случай дыры в браузере или CSRF через iframe с этого же домена.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function ensureToken(req) {
    if (!req.session) return null;
    if (!req.session.csrf) {
        req.session.csrf = crypto.randomBytes(24).toString('base64url');
    }
    return req.session.csrf;
}

/**
 * Middleware: проставляет res.locals.csrfToken и req.csrfToken().
 */
function csrfState(req, res, next) {
    const token = ensureToken(req);
    res.locals.csrfToken = token;
    req.csrfToken = () => token;
    next();
}

/**
 * Middleware: проверяет CSRF на mutating-запросах при наличии сессии.
 */
function csrfGuard(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();

    // Если сессии нет — это либо API участника (cs.participant cookie вместо
    // session), либо просто публичный API. Защита не нужна / делается иначе.
    if (!req.session || !req.session.csrf) return next();

    const provided =
        (req.body && (req.body._csrf || req.body.csrfToken)) ||
        req.headers['x-csrf-token'] ||
        req.headers['csrf-token'];

    if (!provided || provided !== req.session.csrf) {
        const err = new Error('invalid csrf token');
        err.status = 403;
        return next(err);
    }
    next();
}

module.exports = { csrfState, csrfGuard };
