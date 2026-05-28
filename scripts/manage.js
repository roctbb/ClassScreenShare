#!/usr/bin/env node
'use strict';

/**
 * CLI для управления приложением.
 *
 * Команды:
 *   create-admin <login> <password>   создать локального админа
 *   list-admins                        вывести список локальных админов
 *   reset-password <login> <password>  сменить пароль локальному админу
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

async function createAdmin([login, password, ...rest]) {
    if (!login || !password) {
        console.error('Usage: manage.js create-admin <login> <password>');
        process.exit(1);
    }
    if (rest.length) {
        console.error('Too many arguments');
        process.exit(1);
    }
    await withDb(async () => {
        const usersService = require('../src/services/users');
        const user = await usersService.createLocalAdmin({ login, password });
        console.log(`Admin created: id=${user.id} login=${user.login}`);
    });
}

async function listAdmins() {
    await withDb(async () => {
        const { User } = require('../src/db/models');
        const users = await User.findAll({
            order: [['id', 'ASC']],
            attributes: ['id', 'login', 'provider', 'name', 'role', 'lastLoginAt'],
        });
        if (!users.length) {
            console.log('(no users)');
            return;
        }
        console.table(users.map((u) => u.toJSON()));
    });
}

async function resetPassword([login, password, ...rest]) {
    if (!login || !password) {
        console.error('Usage: manage.js reset-password <login> <password>');
        process.exit(1);
    }
    if (rest.length) {
        console.error('Too many arguments');
        process.exit(1);
    }
    await withDb(async () => {
        const { User } = require('../src/db/models');
        const usersService = require('../src/services/users');
        const user = await User.findOne({ where: { provider: 'local', login } });
        if (!user) {
            console.error(`User not found: provider=local login=${login}`);
            process.exit(1);
        }
        user.passwordHash = await usersService.hashPassword(password);
        await user.save();
        console.log(`Password updated for ${login}`);
    });
}

async function main() {
    const [cmd, ...args] = process.argv.slice(2);
    try {
        switch (cmd) {
            case 'create-admin':
                await createAdmin(args);
                break;
            case 'list-admins':
                await listAdmins();
                break;
            case 'reset-password':
                await resetPassword(args);
                break;
            case undefined:
            case '--help':
            case '-h':
            case 'help':
                console.log(
                    [
                        'Usage: npm run manage <command>',
                        '',
                        'Commands:',
                        '  create-admin <login> <password>     create a local admin user',
                        '  list-admins                          list all users',
                        '  reset-password <login> <password>   reset local admin password',
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
