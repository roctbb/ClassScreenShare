import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.DB_PORT = process.env.DB_PORT || '5433';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-1234567890abcdef';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const { sequelize, waitForDb } = await import('../src/db/index.js');
const { runMigrations } = await import('../src/db/migrator.js');
await import('../src/db/models/index.js');
const { User, Participant, ParticipantConnection } = await import('../src/db/models/index.js');
const examsService = await import('../src/services/exams.js');
const participantsService = await import('../src/services/participants.js');
const participantConnectionsService = await import('../src/services/participantConnections.js');
const usersService = await import('../src/services/users.js');

beforeAll(async () => {
    await waitForDb({ retries: 10, delayMs: 500 });
    await runMigrations();
});

afterAll(async () => {
    await sequelize.close();
});

beforeEach(async () => {
    await sequelize.query(
        'TRUNCATE TABLE frames, recordings, participant_connections, participants, exams, users RESTART IDENTITY CASCADE'
    );
});

describe('exams service', () => {
    it('creates an exam with auto-generated code', async () => {
        const admin = await usersService.upsertGeekclassUser({
            externalId: '1',
            name: 'Admin',
            role: 'admin',
        });
        const exam = await examsService.createExam({ name: 'Алгебра', createdBy: admin.id });
        expect(exam.id).toBeGreaterThan(0);
        expect(exam.code).toMatch(/^[A-Z2-9]{8}$/);
        expect(exam.status).toBe('draft');
        expect(exam.createdBy).toBe(admin.id);
        expect(exam.captureInterval).toBeGreaterThan(0);
    });

    it('creates an exam with manual normalized code', async () => {
        const exam = await examsService.createExam({ name: 'Алгебра', code: ' math-9 ' });
        expect(exam.code).toBe('MATH-9');
    });

    it('rejects duplicate manual code', async () => {
        await examsService.createExam({ name: 'Алгебра', code: 'MATH-9' });
        await expect(
            examsService.createExam({ name: 'Геометрия', code: 'math-9' })
        ).rejects.toMatchObject({ status: 409 });
    });

    it('rejects empty name', async () => {
        await expect(examsService.createExam({ name: '   ' })).rejects.toMatchObject({
            status: 400,
        });
    });

    it('rejects invalid manual code', async () => {
        await expect(
            examsService.createExam({ name: 'Test', code: 'no/slash' })
        ).rejects.toMatchObject({
            status: 400,
        });
    });

    it('finds exam by code (case-insensitive)', async () => {
        const e = await examsService.createExam({ name: 'Test' });
        const found = await examsService.getExamByCode(e.code.toLowerCase());
        expect(found).not.toBeNull();
        expect(found.id).toBe(e.id);
    });

    it('activates draft exam', async () => {
        const e = await examsService.createExam({ name: 'Test' });
        const activated = await examsService.activateExam(e.id);
        expect(activated.status).toBe('active');
        expect(activated.startedAt).toBeInstanceOf(Date);
    });

    it('refuses to activate finished exam', async () => {
        const e = await examsService.createExam({ name: 'Test' });
        await examsService.activateExam(e.id);
        await examsService.finishExam(e.id);
        await expect(examsService.activateExam(e.id)).rejects.toMatchObject({ status: 400 });
    });

    it('finishes active exam and sets finishedAt', async () => {
        const e = await examsService.createExam({ name: 'Test' });
        await examsService.activateExam(e.id);
        const finished = await examsService.finishExam(e.id);
        expect(finished.status).toBe('finished');
        expect(finished.finishedAt).toBeInstanceOf(Date);
    });

    it('deleteExam cascades to participants', async () => {
        const e = await examsService.createExam({ name: 'Test' });
        await Participant.create({
            examId: e.id,
            name: 'Иван',
            geekclassId: '999',
            joinedAt: new Date(),
        });
        const ok = await examsService.deleteExam(e.id);
        expect(ok).toBe(true);
        const cnt = await Participant.count({ where: { examId: e.id } });
        expect(cnt).toBe(0);
    });
});

describe('participants service', () => {
    let exam;
    beforeEach(async () => {
        exam = await examsService.createExam({ name: 'Test' });
        await examsService.activateExam(exam.id);
    });

    it('creates new participant on first join', async () => {
        const { participant, resumed } = await participantsService.joinOrResume({
            examId: exam.id,
            name: 'Иван Петров',
            geekclassId: '42',
        });
        expect(resumed).toBe(false);
        expect(participant.name).toBe('Иван Петров');
        expect(participant.geekclassId).toBe('42');
    });

    it('resumes existing participant when geekclassId matches', async () => {
        const first = await participantsService.joinOrResume({
            examId: exam.id,
            name: 'Иван',
            geekclassId: '42',
        });
        const second = await participantsService.joinOrResume({
            examId: exam.id,
            name: 'Иван',
            geekclassId: '42',
        });
        expect(second.resumed).toBe(true);
        expect(second.participant.id).toBe(first.participant.id);
    });

    it('updates name on resume if changed', async () => {
        const first = await participantsService.joinOrResume({
            examId: exam.id,
            name: 'Иван',
            geekclassId: '42',
        });
        const second = await participantsService.joinOrResume({
            examId: exam.id,
            name: 'Иван Петров',
            geekclassId: '42',
        });
        expect(second.participant.id).toBe(first.participant.id);
        expect(second.participant.name).toBe('Иван Петров');
    });

    it('clears leftAt on resume', async () => {
        const first = await participantsService.joinOrResume({
            examId: exam.id,
            name: 'Иван',
            geekclassId: '42',
        });
        await participantsService.leave(first.participant.id);
        const second = await participantsService.joinOrResume({
            examId: exam.id,
            name: 'Иван',
            geekclassId: '42',
        });
        expect(second.resumed).toBe(true);
        expect(second.participant.leftAt).toBeNull();
    });

    it('creates separate participants for same user in different exams', async () => {
        const otherExam = await examsService.createExam({ name: 'Other' });
        await examsService.activateExam(otherExam.id);
        const first = await participantsService.joinOrResume({
            examId: exam.id,
            name: 'Иван',
            geekclassId: '42',
        });
        const second = await participantsService.joinOrResume({
            examId: otherExam.id,
            name: 'Иван',
            geekclassId: '42',
        });
        expect(second.resumed).toBe(false);
        expect(second.participant.id).not.toBe(first.participant.id);
    });

    it('rejects empty/missing name', async () => {
        await expect(
            participantsService.joinOrResume({ examId: exam.id, name: '', geekclassId: '1' })
        ).rejects.toMatchObject({ status: 400 });
        await expect(
            participantsService.joinOrResume({ examId: exam.id, name: '   ', geekclassId: '1' })
        ).rejects.toMatchObject({ status: 400 });
    });

    it('rejects missing geekclassId', async () => {
        await expect(
            participantsService.joinOrResume({ examId: exam.id, name: 'Иван' })
        ).rejects.toMatchObject({ status: 400 });
    });

    it('truncates user_agent if too long', async () => {
        const longUa = 'X'.repeat(1000);
        const { participant } = await participantsService.joinOrResume({
            examId: exam.id,
            name: 'Иван',
            geekclassId: '42',
            userAgent: longUa,
        });
        expect(participant.userAgent.length).toBeLessThanOrEqual(512);
    });

    it('findByGeekclassId returns participant', async () => {
        const { participant } = await participantsService.joinOrResume({
            examId: exam.id,
            name: 'Иван',
            geekclassId: '42',
        });
        const found = await participantsService.findByGeekclassId(exam.id, '42');
        expect(found).not.toBeNull();
        expect(found.id).toBe(participant.id);
    });

    it('findByGeekclassId returns null for unknown id', async () => {
        const found = await participantsService.findByGeekclassId(exam.id, 'unknown');
        expect(found).toBeNull();
    });
});

describe('participant connection logs', () => {
    it('stores socket connection events for a participant', async () => {
        const exam = await examsService.createExam({ name: 'Test' });
        const { participant } = await participantsService.joinOrResume({
            examId: exam.id,
            name: 'Иван',
            geekclassId: '42',
        });

        const event = await ParticipantConnection.create({
            participantId: participant.id,
            examId: exam.id,
            socketId: 'socket-1',
            event: 'connect',
            ip: '127.0.0.1',
            userAgent: 'test-agent',
        });

        expect(event.id).toBeTruthy();
        const count = await ParticipantConnection.count({
            where: { participantId: participant.id },
        });
        expect(count).toBe(1);
    });

    it('listForExam groups events by participantId', async () => {
        const exam = await examsService.createExam({ name: 'Test' });
        const p1 = await participantsService.joinOrResume({
            examId: exam.id,
            name: 'A',
            geekclassId: '1',
        });
        const p2 = await participantsService.joinOrResume({
            examId: exam.id,
            name: 'B',
            geekclassId: '2',
        });
        await ParticipantConnection.create({
            participantId: p1.participant.id,
            examId: exam.id,
            socketId: 's1',
            event: 'connect',
        });
        await ParticipantConnection.create({
            participantId: p2.participant.id,
            examId: exam.id,
            socketId: 's2',
            event: 'connect',
        });
        const map = await participantConnectionsService.listForExam(exam.id);
        expect(map.size).toBe(2);
        expect(map.get(p1.participant.id)).toHaveLength(1);
        expect(map.get(p2.participant.id)).toHaveLength(1);
    });

    it('builds readable connection sessions from socket events', () => {
        const startedAt = new Date('2026-05-28T10:00:00Z');
        const endedAt = new Date('2026-05-28T10:01:05Z');
        const timeline = participantConnectionsService.buildConnectionSessions(
            [
                {
                    socketId: 'very-long-socket-id-123456',
                    event: 'connect',
                    ip: '127.0.0.1',
                    userAgent: 'test-agent',
                    createdAt: startedAt,
                },
                {
                    socketId: 'very-long-socket-id-123456',
                    event: 'disconnect',
                    reason: 'transport close',
                    createdAt: endedAt,
                },
            ],
            { now: new Date('2026-05-28T10:02:00Z') }
        );

        expect(timeline.summary.isOnline).toBe(false);
        expect(timeline.summary.totalSessions).toBe(1);
        expect(timeline.sessions[0].status).toBe('closed');
        expect(timeline.sessions[0].durationLabel).toBe('1 мин 5 сек');
        expect(timeline.sessions[0].reasonLabel).toBe('соединение закрыто');
        expect(timeline.sessions[0].socketShort).toMatch(/^very-lon/);
    });

    it('marks a session as online when there is no disconnect event', () => {
        const timeline = participantConnectionsService.buildConnectionSessions(
            [
                {
                    socketId: 'socket-1',
                    event: 'connect',
                    createdAt: new Date('2026-05-28T10:00:00Z'),
                },
            ],
            { now: new Date('2026-05-28T10:00:12Z') }
        );

        expect(timeline.summary.isOnline).toBe(true);
        expect(timeline.summary.activeSessions).toBe(1);
        expect(timeline.sessions[0].durationLabel).toBe('12 сек');
    });

    it('calcTotalAbsenceMs sums gaps between non-overlapping sessions', () => {
        // Сессия 1: 10:00-10:05 (5 мин), пропуск 2 мин, сессия 2: 10:07-10:10
        // Итого отсутствие = 2 минуты = 120 000 мс
        const timeline = participantConnectionsService.buildConnectionSessions(
            [
                {
                    socketId: 's1',
                    event: 'connect',
                    createdAt: new Date('2026-05-28T10:00:00Z'),
                },
                {
                    socketId: 's1',
                    event: 'disconnect',
                    reason: 'transport close',
                    createdAt: new Date('2026-05-28T10:05:00Z'),
                },
                {
                    socketId: 's2',
                    event: 'connect',
                    createdAt: new Date('2026-05-28T10:07:00Z'),
                },
                {
                    socketId: 's2',
                    event: 'disconnect',
                    reason: 'transport close',
                    createdAt: new Date('2026-05-28T10:10:00Z'),
                },
            ],
            { now: new Date('2026-05-28T10:11:00Z') }
        );
        expect(timeline.summary.totalAbsenceMs).toBe(2 * 60 * 1000);
    });

    it('calcTotalAbsenceMs ignores overlapping sessions', () => {
        // Две сессии перекрываются — отсутствия нет.
        const timeline = participantConnectionsService.buildConnectionSessions(
            [
                {
                    socketId: 's1',
                    event: 'connect',
                    createdAt: new Date('2026-05-28T10:00:00Z'),
                },
                {
                    socketId: 's2',
                    event: 'connect',
                    createdAt: new Date('2026-05-28T10:02:00Z'),
                },
                {
                    socketId: 's1',
                    event: 'disconnect',
                    reason: 'transport close',
                    createdAt: new Date('2026-05-28T10:05:00Z'),
                },
                {
                    socketId: 's2',
                    event: 'disconnect',
                    reason: 'transport close',
                    createdAt: new Date('2026-05-28T10:08:00Z'),
                },
            ],
            { now: new Date('2026-05-28T10:09:00Z') }
        );
        expect(timeline.summary.totalAbsenceMs).toBe(0);
    });
});

describe('users service (GeekClass)', () => {
    it('upsertGeekclassUser creates user with role', async () => {
        const u = await usersService.upsertGeekclassUser({
            externalId: '42',
            name: 'Иван',
            role: 'teacher',
        });
        expect(u.provider).toBe('geekclass');
        expect(u.externalId).toBe('42');
        expect(u.role).toBe('teacher');
    });

    it('upsertGeekclassUser updates existing user by external_id', async () => {
        const u1 = await usersService.upsertGeekclassUser({
            externalId: '42',
            name: 'Test',
            role: 'teacher',
        });

        const u2 = await usersService.upsertGeekclassUser({
            externalId: 42,
            name: 'Test Updated',
            role: 'admin',
        });
        expect(u2.id).toBe(u1.id);
        expect(u2.name).toBe('Test Updated');
        expect(u2.role).toBe('admin');

        const total = await User.count({ where: { provider: 'geekclass' } });
        expect(total).toBe(1);
    });

    it('upsertGeekclassUser defaults invalid role to teacher', async () => {
        const u = await usersService.upsertGeekclassUser({
            externalId: '42',
            name: 'Test',
            role: 'student',
        });
        expect(u.role).toBe('teacher');
    });
});
