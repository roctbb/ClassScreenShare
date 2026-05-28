'use strict';

const { DataTypes, Model } = require('sequelize');

class ParticipantConnection extends Model {}

const EVENT = Object.freeze({
    CONNECT: 'connect',
    DISCONNECT: 'disconnect',
});

function init(sequelize) {
    ParticipantConnection.init(
        {
            id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
            participantId: {
                type: DataTypes.INTEGER,
                allowNull: false,
                field: 'participant_id',
            },
            examId: {
                type: DataTypes.INTEGER,
                allowNull: false,
                field: 'exam_id',
            },
            socketId: {
                type: DataTypes.STRING(128),
                allowNull: false,
                field: 'socket_id',
            },
            event: {
                type: DataTypes.STRING(32),
                allowNull: false,
                validate: { isIn: [Object.values(EVENT)] },
            },
            reason: { type: DataTypes.STRING(128), allowNull: true },
            ip: { type: DataTypes.STRING(64), allowNull: true },
            userAgent: { type: DataTypes.STRING(512), allowNull: true, field: 'user_agent' },
        },
        {
            sequelize,
            modelName: 'ParticipantConnection',
            tableName: 'participant_connections',
            underscored: true,
            timestamps: true,
            updatedAt: false,
        }
    );
    return ParticipantConnection;
}

ParticipantConnection.EVENT = EVENT;

module.exports = { ParticipantConnection, init, EVENT };
