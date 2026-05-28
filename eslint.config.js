'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

module.exports = [
    {
        ignores: ['node_modules/', 'recordings/', 'coverage/', '*.min.js'],
    },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
            },
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            'no-console': 'off',
            'no-empty': ['error', { allowEmptyCatch: true }],
            eqeqeq: ['error', 'smart'],
            'prefer-const': 'warn',
            'no-var': 'error',
        },
    },
    {
        // Браузерный код — другой набор глобалов.
        files: ['public/js/**/*.js'],
        languageOptions: {
            sourceType: 'script',
            globals: {
                ...globals.browser,
                io: 'readonly', // socket.io.client из CDN
            },
        },
    },
    {
        // ESM-конфиги (vitest, eslint).
        files: ['vitest.config.js', 'eslint.config.js', 'tests/**/*.js'],
        languageOptions: {
            sourceType: 'module',
            globals: {
                ...globals.node,
            },
        },
    },
    prettier,
];
