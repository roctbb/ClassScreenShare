'use strict';

const { DataTypes, Model } = require('sequelize');

class Participant extends Model {}

function init(sequelize) {
    Participant.init(
        {
            id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
            examId: {
                type: DataTypes.INTEGER,
                allowNull: false,
                field: 'exam_id',
            },
            name: { type: DataTypes.STRING(255), allowNull: false },
            token: { type: DataTypes.STRING(64), allowNull: false },
            joinedAt: { type: DataTypes.DATE, allowNull: false, field: 'joined_at' },
            leftAt: { type: DataTypes.DATE, allowNull: true, field: 'left_at' },
            lastSeenAt: { type: DataTypes.DATE, allowNull: true, field: 'last_seen_at' },
            ip: { type: DataTypes.STRING(64), allowNull: true },
            userAgent: { type: DataTypes.STRING(512), allowNull: true, field: 'user_agent' },
        },
        {
            sequelize,
            modelName: 'Participant',
            tableName: 'participants',
            underscored: true,
        }
    );
    return Participant;
}

module.exports = { Participant, init };
