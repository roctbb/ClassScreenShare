'use strict';

/**
 * Token больше не используется для аутентификации участника (заменён на
 * пару cookies cs.participant.gc + cs.participant.pid и поле geekclass_id).
 * Убираем UNIQUE индекс и делаем поле nullable, чтобы:
 *   - один geekclass-пользователь мог участвовать в нескольких экзаменах
 *     без коллизий по токену
 *   - не генерировать токен впустую для новых участников
 */
module.exports = {
    async up(qi, DataTypes) {
        // Удаляем UNIQUE индекс.
        await qi.removeIndex('participants', 'participants_token_uq');
        // Делаем поле nullable.
        await qi.changeColumn('participants', 'token', {
            type: DataTypes.STRING(64),
            allowNull: true,
        });
    },

    async down(qi, DataTypes) {
        // Сначала заполнить null'ы случайным значением, иначе CHANGE NOT NULL упадёт.
        await qi.sequelize.query(`
            UPDATE participants
            SET token = encode(gen_random_bytes(24), 'base64')
            WHERE token IS NULL
        `);
        await qi.changeColumn('participants', 'token', {
            type: DataTypes.STRING(64),
            allowNull: false,
        });
        await qi.addIndex('participants', {
            fields: ['token'],
            unique: true,
            name: 'participants_token_uq',
        });
    },
};
