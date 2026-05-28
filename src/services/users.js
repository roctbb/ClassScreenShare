'use strict';

const { User } = require('../db/models');

/**
 * Upsert пользователя из GeekClass JWT payload.
 * Идемпотентный: если уже есть запись с (provider='geekclass', external_id=id) — обновит её.
 * Сохраняет роль как есть из JWT (teacher/admin); другие роли отбрасываются на teacher.
 *
 * Авторизация в системе работает только через GeekClass — локальных пользователей
 * с паролем больше не существует.
 */
async function upsertGeekclassUser({ externalId, name, role }) {
    const safeRole = role === 'teacher' || role === 'admin' ? role : 'teacher';
    let user = await User.findOne({
        where: { provider: 'geekclass', externalId: String(externalId) },
    });
    if (!user) {
        user = await User.create({
            provider: 'geekclass',
            externalId: String(externalId),
            login: `gc_${externalId}`,
            name: name || `gc_${externalId}`,
            role: safeRole,
            lastLoginAt: new Date(),
        });
    } else {
        user.name = name || user.name;
        user.role = safeRole;
        user.lastLoginAt = new Date();
        await user.save();
    }
    return user;
}

module.exports = {
    upsertGeekclassUser,
};
