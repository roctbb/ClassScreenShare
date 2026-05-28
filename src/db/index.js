'use strict';

const { Sequelize } = require('sequelize');
const config = require('../config');
const logger = require('../logger');

const sequelize = new Sequelize({
    dialect: 'postgres',
    host: config.db.host,
    port: config.db.port,
    database: config.db.name,
    username: config.db.user,
    password: config.db.password,
    logging: (msg) => logger.trace({ sql: msg }, 'sequelize'),
    pool: {
        max: 10,
        min: 0,
        acquire: 30000,
        idle: 10000,
    },
    define: {
        underscored: true,
        timestamps: true,
        createdAt: 'created_at',
        updatedAt: 'updated_at',
    },
});

async function waitForDb({ retries = 30, delayMs = 1000 } = {}) {
    for (let i = 0; i < retries; i++) {
        try {
            await sequelize.authenticate();
            return;
        } catch (err) {
            if (i === retries - 1) throw err;
            logger.warn({ attempt: i + 1, retries }, 'database not ready, retrying');
            await new Promise((r) => setTimeout(r, delayMs));
        }
    }
}

module.exports = { sequelize, waitForDb };
