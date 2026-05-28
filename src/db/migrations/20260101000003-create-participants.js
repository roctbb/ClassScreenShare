'use strict';

module.exports = {
    async up(qi, DataTypes) {
        await qi.createTable('participants', {
            id: {
                type: DataTypes.INTEGER,
                primaryKey: true,
                autoIncrement: true,
            },
            exam_id: {
                type: DataTypes.INTEGER,
                allowNull: false,
                references: { model: 'exams', key: 'id' },
                onDelete: 'CASCADE',
                onUpdate: 'CASCADE',
            },
            name: {
                type: DataTypes.STRING(255),
                allowNull: false,
            },
            // Случайный токен, выдаваемый участнику в cookie.
            // Позволяет вернуться в свою же запись после reconnect.
            token: {
                type: DataTypes.STRING(64),
                allowNull: false,
            },
            joined_at: {
                type: DataTypes.DATE,
                allowNull: false,
                defaultValue: DataTypes.literal('CURRENT_TIMESTAMP'),
            },
            // Время выхода — когда явно нажал "Завершить" или экзамен закончился.
            // Disconnect не считается left_at, т.к. можно вернуться.
            left_at: {
                type: DataTypes.DATE,
                allowNull: true,
            },
            // Время последнего полученного кадра. Обновляется при каждом share_screen.
            last_seen_at: {
                type: DataTypes.DATE,
                allowNull: true,
            },
            ip: {
                type: DataTypes.STRING(64),
                allowNull: true,
            },
            user_agent: {
                type: DataTypes.STRING(512),
                allowNull: true,
            },
            created_at: {
                type: DataTypes.DATE,
                allowNull: false,
                defaultValue: DataTypes.literal('CURRENT_TIMESTAMP'),
            },
            updated_at: {
                type: DataTypes.DATE,
                allowNull: false,
                defaultValue: DataTypes.literal('CURRENT_TIMESTAMP'),
            },
        });

        await qi.addIndex('participants', {
            fields: ['exam_id'],
            name: 'participants_exam_id_idx',
        });
        // Уникальность токена в рамках экзамена. Сам токен криптографически
        // случайный, коллизия маловероятна, но индекс нужен для быстрого поиска.
        await qi.addIndex('participants', {
            fields: ['token'],
            unique: true,
            name: 'participants_token_uq',
        });
    },

    async down(qi) {
        await qi.dropTable('participants');
    },
};
