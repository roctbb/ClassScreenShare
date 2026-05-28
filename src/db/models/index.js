'use strict';

const { sequelize } = require('../index');

const userMod = require('./User');
const examMod = require('./Exam');
const participantMod = require('./Participant');
const frameMod = require('./Frame');
const recordingMod = require('./Recording');

const User = userMod.init(sequelize);
const Exam = examMod.init(sequelize);
const Participant = participantMod.init(sequelize);
const Frame = frameMod.init(sequelize);
const Recording = recordingMod.init(sequelize);

// Ассоциации.
User.hasMany(Exam, { foreignKey: 'createdBy', as: 'exams' });
Exam.belongsTo(User, { foreignKey: 'createdBy', as: 'creator' });

Exam.hasMany(Participant, { foreignKey: 'examId', as: 'participants', onDelete: 'CASCADE' });
Participant.belongsTo(Exam, { foreignKey: 'examId', as: 'exam' });

Participant.hasMany(Frame, { foreignKey: 'participantId', as: 'frames', onDelete: 'CASCADE' });
Frame.belongsTo(Participant, { foreignKey: 'participantId', as: 'participant' });

Participant.hasOne(Recording, {
    foreignKey: 'participantId',
    as: 'recording',
    onDelete: 'CASCADE',
});
Recording.belongsTo(Participant, { foreignKey: 'participantId', as: 'participant' });

module.exports = {
    sequelize,
    User,
    Exam,
    Participant,
    Frame,
    Recording,
};
