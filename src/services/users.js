'use strict';

const bcrypt = require('bcrypt');
const { User } = require('../db/models');
const logger = require('../logger');

const BCRYPT_ROUNDS = 12;

async function hashPassword(plain) {
    return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

async function verifyPassword(plain, hash) {
    if (!hash) return false;
    return bcrypt.compare(plain, hash);
}

/**
 * Создать локального админа.
 * @returns {Promise<User>}
 */
async function createLocalAdmin({ login, password, name = null }) {
    if (!login || !password) {
        throw new Error('login and password are required');
    }
    if (password.length < 6) {
        throw new Error('password must be at least 6 characters');
    }
    const passwordHash = await hashPassword(password);
    return User.create({
        login,
        passwordHash,
        provider: 'local',
        name: name || login,
        role: 'admin',
    });
}

/**
 * Аутентификация по логину/паролю в provider='local'.
 * @returns {Promise<User|null>}
 */
async function authenticateLocal(login, password) {
    const user = await User.findOne({ where: { provider: 'local', login } });
    if (!user) return null;
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) return null;
    user.lastLoginAt = new Date();
    await user.save();
    return user;
}

/**
 * Upsert пользователя из GeekClass JWT payload.
 * Идемпотентный: если уже есть запись с (provider='geekclass', external_id=id) — обновит её.
 */
async function upsertGeekclassUser({ externalId, name, role }) {
    let user = await User.findOne({
        where: { provider: 'geekclass', externalId: String(externalId) },
    });
    if (!user) {
        user = await User.create({
            provider: 'geekclass',
            externalId: String(externalId),
            login: `gc_${externalId}`,
            name: name || `gc_${externalId}`,
            role: role === 'teacher' || role === 'admin' ? role : 'admin',
            lastLoginAt: new Date(),
        });
    } else {
        user.name = name || user.name;
        if (role === 'teacher' || role === 'admin') user.role = role;
        user.lastLoginAt = new Date();
        await user.save();
    }
    return user;
}

/**
 * Если в БД нет ни одного пользователя — создать первого админа из ENV.
 */
async function bootstrapFromEnv({ login, password }) {
    if (!login || !password) {
        logger.warn(
            'ADMIN_LOGIN/ADMIN_PASSWORD not set — skipping admin bootstrap. ' +
                'You will need to create admin manually via: npm run manage create-admin <login> <password>'
        );
        return null;
    }
    const count = await User.count();
    if (count > 0) {
        logger.debug('users table not empty, skipping bootstrap');
        return null;
    }
    const admin = await createLocalAdmin({ login, password });
    logger.info({ login: admin.login }, 'bootstrap admin created from env');
    return admin;
}

module.exports = {
    hashPassword,
    verifyPassword,
    createLocalAdmin,
    authenticateLocal,
    upsertGeekclassUser,
    bootstrapFromEnv,
};
