'use strict';

// Программный запуск миграций (без sequelize-cli).
// Используется при старте сервера, чтобы автоматически применять
// миграции в Docker-окружении.

const path = require('path');
const fs = require('fs');
const { sequelize } = require('./index');
const logger = require('../logger');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureMetaTable() {
    const qi = sequelize.getQueryInterface();
    const tables = await qi.showAllTables();
    if (!tables.includes('SequelizeMeta')) {
        await qi.createTable('SequelizeMeta', {
            name: {
                type: sequelize.Sequelize.STRING,
                primaryKey: true,
                allowNull: false,
            },
        });
    }
}

async function getApplied() {
    const [rows] = await sequelize.query('SELECT name FROM "SequelizeMeta" ORDER BY name ASC');
    return new Set(rows.map((r) => r.name));
}

async function markApplied(name) {
    await sequelize.query('INSERT INTO "SequelizeMeta" (name) VALUES (:name)', {
        replacements: { name },
    });
}

async function runMigrations() {
    await ensureMetaTable();
    const applied = await getApplied();
    const files = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.js'))
        .sort();

    for (const file of files) {
        if (applied.has(file)) continue;
        logger.info({ migration: file }, 'applying migration');
        const migration = require(path.join(MIGRATIONS_DIR, file));
        try {
            await migration.up(sequelize.getQueryInterface(), sequelize.Sequelize);
            await markApplied(file);
            logger.info({ migration: file }, 'migration applied');
        } catch (err) {
            logger.error({ migration: file, err: err.message }, 'migration failed');
            throw err;
        }
    }
}

module.exports = { runMigrations };
