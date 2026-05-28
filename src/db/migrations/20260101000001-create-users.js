'use strict';

module.exports = {
    /**
     * @param {import('sequelize').QueryInterface} qi
     * @param {import('sequelize').DataTypes} DataTypes
     */
    async up(qi, DataTypes) {
        await qi.createTable('users', {
            id: {
                type: DataTypes.INTEGER,
                primaryKey: true,
                autoIncrement: true,
            },
            login: {
                type: DataTypes.STRING(128),
                allowNull: false,
            },
            password_hash: {
                type: DataTypes.STRING(255),
                allowNull: true, // nullable для GeekClass-пользователей
            },
            provider: {
                // 'local' или 'geekclass'
                type: DataTypes.STRING(32),
                allowNull: false,
                defaultValue: 'local',
            },
            external_id: {
                // ID пользователя во внешней системе (GeekClass).
                // Для local — null.
                type: DataTypes.STRING(128),
                allowNull: true,
            },
            name: {
                type: DataTypes.STRING(255),
                allowNull: true,
            },
            role: {
                type: DataTypes.STRING(32),
                allowNull: false,
                defaultValue: 'admin',
            },
            last_login_at: {
                type: DataTypes.DATE,
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

        await qi.addIndex('users', {
            fields: ['provider', 'login'],
            unique: true,
            name: 'users_provider_login_uq',
        });
        // Частичный уникальный индекс на (provider, external_id) только когда
        // external_id не NULL. Делаем через raw SQL, т.к. sequelize-абстракция
        // для частичных индексов с разными NULL не везде корректна.
        await qi.sequelize.query(`
            CREATE UNIQUE INDEX users_provider_external_id_uq
            ON users (provider, external_id)
            WHERE external_id IS NOT NULL
        `);
    },

    async down(qi) {
        await qi.dropTable('users');
    },
};
