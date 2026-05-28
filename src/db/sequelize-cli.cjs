'use strict';

// Конфиг для sequelize-cli (миграции).
// CLI умеет читать .cjs/.json — используем .cjs, т.к. проект CommonJS.
require('dotenv').config();

const common = {
    dialect: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'classscreenshare',
    username: process.env.DB_USER || 'classscreenshare',
    password: process.env.DB_PASSWORD || 'classscreenshare',
    logging: false,
};

module.exports = {
    development: common,
    test: common,
    production: common,
};
