'use strict';

const { DataTypes, Model } = require('sequelize');

class User extends Model {}

function init(sequelize) {
    User.init(
        {
            id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
            login: { type: DataTypes.STRING(128), allowNull: false },
            passwordHash: { type: DataTypes.STRING(255), allowNull: true, field: 'password_hash' },
            provider: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'local' },
            externalId: { type: DataTypes.STRING(128), allowNull: true, field: 'external_id' },
            name: { type: DataTypes.STRING(255), allowNull: true },
            role: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'admin' },
            lastLoginAt: { type: DataTypes.DATE, allowNull: true, field: 'last_login_at' },
        },
        {
            sequelize,
            modelName: 'User',
            tableName: 'users',
            underscored: true,
        }
    );
    return User;
}

module.exports = { User, init };
