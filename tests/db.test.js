import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

// ENV для подключения должен быть выставлен ДО импорта db/index.
process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.DB_PORT = process.env.DB_PORT || '5433';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-1234567890abcdef';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const { sequelize, waitForDb } = await import('../src/db/index.js');
const { runMigrations } = await import('../src/db/migrator.js');
await import('../src/db/models/index.js');
const { User, Participant } = await import('../src/db/models/index.js');
const examsService = await import('../src/services/exams.js');
const participantsService = await import('../src/services/participants.js');
const usersService = await import('../src/services/users.js');

beforeAll(async () => {
    await waitForDb({ retries: 10, delayMs: 500 });
    await runMigrations();
});

afterAll(async () => {
    await sequelize.close();
});

beforeEach(async () => {
    // Чистим таблицы перед каждым тестом, чтобы изоляция была.
    await sequelize.query(
        'TRUNCATE TABLE frames, recordings, participants, exams, users RESTART IDENTITY CASCADE'
    );
});

describe('exams service', () => {
    it('creates an exam with auto-generated code', async () => {
        const admin = await usersService.createLocalAdmin({
            login: 'admin',
            password: 'secret123',
        });
        const exam = await examsService.createExam({ name: 'Алгебра', createdBy: admin.id });
        expect(exam.id).toBeGreaterThan(0);
        expect(exam.code).toMatch(/^[A-Z2-9]{8}$/);
        expect(exam.status).toBe('draft');
        expect(exam.createdBy).toBe(admin.id);
        expect(exam.captureInterval).toBeGreaterThan(0);
    });

    it('rejects empty name', async () => {
        await expect(examsService.createExam({ name: '   ' })).rejects.toMatchObject({
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
            token: 'sometoken',
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

    it('creates new participant when no token', async () => {
        const { participant, resumed } = await participantsService.joinOrResume({
            examId: exam.id,
            name: 'Иван Петров',
        });
        expect(resumed).toBe(false);
        expect(participant.name).toBe('Иван Петров');
        expect(participant.token).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('resumes existing participant when token matches', async () => {
        const first = await participantsService.joinOrResume({
            examId: exam.id,
            name: 'Иван',
        });
        const second = await participantsService.joinOrResume({
            examId: exam.id,
            name: 'Иван',
            token: first.participant.token,
        });
        expect(second.resumed).toBe(true);
        expect(second.participant.id).toBe(first.participant.id);
    });

    it('updates name on resume if changed', async () => {
        const first = await participantsService.joinOrResume({
            examId: exam.id,
            name: 'Иван',
        });
        const second = await participantsService.joinOrResume({
            examId: exam.id,
            name: 'Иван Петров',
            token: first.participant.token,
        });
        expect(second.participant.id).toBe(first.participant.id);
        expect(second.participant.name).toBe('Иван Петров');
    });

    it('creates new participant when token belongs to another exam', async () => {
        const otherExam = await examsService.createExam({ name: 'Other' });
        await examsService.activateExam(otherExam.id);
        const first = await participantsService.joinOrResume({
            examId: exam.id,
            name: 'Иван',
        });
        const second = await participantsService.joinOrResume({
            examId: otherExam.id,
            name: 'Иван',
            token: first.participant.token, // токен от другого экзамена
        });
        expect(second.resumed).toBe(false);
        expect(second.participant.id).not.toBe(first.participant.id);
    });

    it('rejects empty/missing name', async () => {
        await expect(
            participantsService.joinOrResume({ examId: exam.id, name: '' })
        ).rejects.toMatchObject({ status: 400 });
        await expect(
            participantsService.joinOrResume({ examId: exam.id, name: '   ' })
        ).rejects.toMatchObject({ status: 400 });
    });

    it('truncates user_agent if too long', async () => {
        const longUa = 'X'.repeat(1000);
        const { participant } = await participantsService.joinOrResume({
            examId: exam.id,
            name: 'Иван',
            userAgent: longUa,
        });
        expect(participant.userAgent.length).toBeLessThanOrEqual(512);
    });
});

describe('users service', () => {
    it('createLocalAdmin hashes password', async () => {
        const u = await usersService.createLocalAdmin({
            login: 'a',
            password: 'secret123',
        });
        expect(u.passwordHash).not.toBe('secret123');
        expect(u.passwordHash).toMatch(/^\$2[aby]\$/); // bcrypt prefix
    });

    it('rejects short passwords', async () => {
        await expect(usersService.createLocalAdmin({ login: 'a', password: '12' })).rejects.toThrow(
            /at least/
        );
    });

    it('authenticateLocal returns user on correct password', async () => {
        await usersService.createLocalAdmin({ login: 'a', password: 'secret123' });
        const u = await usersService.authenticateLocal('a', 'secret123');
        expect(u).not.toBeNull();
        expect(u.lastLoginAt).toBeInstanceOf(Date);
    });

    it('authenticateLocal returns null on wrong password', async () => {
        await usersService.createLocalAdmin({ login: 'a', password: 'secret123' });
        const u = await usersService.authenticateLocal('a', 'wrong');
        expect(u).toBeNull();
    });

    it('authenticateLocal returns null for non-existent user', async () => {
        const u = await usersService.authenticateLocal('nobody', 'pw');
        expect(u).toBeNull();
    });

    it('upsertGeekclassUser creates and updates by external_id', async () => {
        const u1 = await usersService.upsertGeekclassUser({
            externalId: '42',
            name: 'Test',
            role: 'teacher',
        });
        expect(u1.provider).toBe('geekclass');
        expect(u1.externalId).toBe('42');

        // Повторный вызов с тем же externalId — обновление, не создание
        const u2 = await usersService.upsertGeekclassUser({
            externalId: 42,
            name: 'Test Updated',
            role: 'admin',
        });
        expect(u2.id).toBe(u1.id);
        expect(u2.name).toBe('Test Updated');

        const total = await User.count({ where: { provider: 'geekclass' } });
        expect(total).toBe(1);
    });

    it('bootstrapFromEnv only creates user when table is empty', async () => {
        await usersService.bootstrapFromEnv({ login: 'admin', password: 'secret123' });
        const cnt1 = await User.count();
        expect(cnt1).toBe(1);
        // Второй вызов — ничего не делает
        await usersService.bootstrapFromEnv({ login: 'admin2', password: 'secret456' });
        const cnt2 = await User.count();
        expect(cnt2).toBe(1);
    });
});
