#!/usr/bin/env node
'use strict';

/**
 * CLI для управления приложением.
 *
 * Авторизация в системе работает только через GeekClass — локальные пароли
 * не используются. Эти команды позволяют посмотреть список пользователей и
 * вручную поменять роль (например, дать teacher → admin).
 *
 * Команды:
 *   list-users                       вывести список пользователей
 *   set-role <userId> <role>         изменить роль (teacher | admin)
 */

const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { sequelize, waitForDb } = require('../src/db');
const { runMigrations } = require('../src/db/migrator');
const logger = require('../src/logger');

async function withDb(fn) {
    await waitForDb({ retries: 5, delayMs: 500 });
    await runMigrations();
    require('../src/db/models');
    try {
        await fn();
    } finally {
        await sequelize.close();
    }
}

async function listUsers() {
    await withDb(async () => {
        const { User } = require('../src/db/models');
        const users = await User.findAll({
            order: [['id', 'ASC']],
            attributes: ['id', 'login', 'provider', 'externalId', 'name', 'role', 'lastLoginAt'],
        });
        if (!users.length) {
            console.log('(no users)');
            return;
        }
        console.table(users.map((u) => u.toJSON()));
    });
}

async function setRole([userIdStr, role, ...rest]) {
    if (!userIdStr || !role) {
        console.error('Usage: manage.js set-role <userId> <admin|teacher>');
        process.exit(1);
    }
    if (rest.length) {
        console.error('Too many arguments');
        process.exit(1);
    }
    if (role !== 'admin' && role !== 'teacher') {
        console.error('Role must be "admin" or "teacher"');
        process.exit(1);
    }
    const userId = Number(userIdStr);
    if (!Number.isInteger(userId) || userId <= 0) {
        console.error('userId must be a positive integer');
        process.exit(1);
    }
    await withDb(async () => {
        const { User } = require('../src/db/models');
        const user = await User.findByPk(userId);
        if (!user) {
            console.error(`User not found: id=${userId}`);
            process.exit(1);
        }
        user.role = role;
        await user.save();
        console.log(`Role updated: id=${user.id} login=${user.login} role=${user.role}`);
    });
}

async function main() {
    const [cmd, ...args] = process.argv.slice(2);
    try {
        switch (cmd) {
            case 'list-users':
            case 'list-admins': // legacy alias
                await listUsers();
                break;
            case 'set-role':
                await setRole(args);
                break;
            case undefined:
            case '--help':
            case '-h':
            case 'help':
                console.log(
                    [
                        'Usage: npm run manage <command>',
                        '',
                        'Authentication is GeekClass-only — there are no local passwords.',
                        'Users are upserted from GeekClass JWT on first login.',
                        '',
                        'Commands:',
                        '  list-users                     list all users',
                        '  set-role <userId> <role>       change user role (admin | teacher)',
                    ].join('\n')
                );
                break;
            default:
                console.error(`Unknown command: ${cmd}`);
                console.error('Run with --help for usage');
                process.exit(1);
        }
    } catch (err) {
        logger.error({ err: err.message, stack: err.stack }, 'manage command failed');
        process.exit(1);
    }
}

main();
