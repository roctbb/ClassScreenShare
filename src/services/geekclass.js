'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const usersService = require('./users');

/**
 * Поток авторизации (по аналогии с GeekExam/backend/auth.py):
 *
 * 1. Браузер открывает /auth/geekclass — мы редиректим на:
 *    GEEKCLASS_HOST/insider/jwt?redirect_url=<encoded PUBLIC_URL/auth/geekclass/callback?next=...>
 * 2. Внешний сервис аутентифицирует и редиректит обратно с ?token=<JWT>
 * 3. Мы валидируем JWT (HS256, JWT_SECRET, iat <= 60 сек),
 *    upsert юзера, ставим session.userId, редиректим на next.
 *
 * Payload JWT (как в GeekClass):
 *   { id, name, role, iat }
 */

function buildLoginUrl(callbackAbsoluteUrl) {
    const base = config.geekclass.host.replace(/\/$/, '');
    return `${base}/insider/jwt?redirect_url=${encodeURIComponent(callbackAbsoluteUrl)}`;
}

/**
 * Декодирует и проверяет JWT.
 * Бросает Error при невалидности / устаревании.
 */
function verifyToken(token) {
    if (!config.geekclass.enabled) {
        throw new Error('geekclass auth is disabled');
    }
    const decoded = jwt.verify(token, config.geekclass.jwtSecret, { algorithms: ['HS256'] });
    if (!decoded || typeof decoded !== 'object') {
        throw new Error('invalid jwt payload');
    }
    if (typeof decoded.id === 'undefined') {
        throw new Error('jwt has no id');
    }
    if (typeof decoded.iat !== 'number') {
        throw new Error('jwt has no iat');
    }
    const ageSeconds = Math.floor(Date.now() / 1000) - decoded.iat;
    if (ageSeconds > 60 || ageSeconds < -60) {
        throw new Error(`jwt is too old or from future: age=${ageSeconds}s`);
    }
    return decoded;
}

/**
 * Принимает токен, возвращает User. Делает upsert.
 * Доступ разрешён только teacher и admin.
 */
async function loginByToken(token) {
    const payload = verifyToken(token);
    const role = payload.role || 'student';
    if (role !== 'teacher' && role !== 'admin') {
        const err = new Error('access denied: teacher or admin role required');
        err.status = 403;
        throw err;
    }
    const user = await usersService.upsertGeekclassUser({
        externalId: payload.id,
        name: payload.name || null,
        role,
    });
    return user;
}

module.exports = { buildLoginUrl, verifyToken, loginByToken };
