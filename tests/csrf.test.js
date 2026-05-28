import { describe, it, expect } from 'vitest';
import { csrfState, csrfGuard } from '../src/middleware/csrf.js';

function fakeReq({ method = 'GET', body = {}, headers = {}, session = null } = {}) {
    return { method, body, headers, session };
}

function fakeRes() {
    return { locals: {} };
}

function runMw(mw, req, res) {
    return new Promise((resolve, reject) => {
        try {
            mw(req, res, (err) => (err ? reject(err) : resolve()));
        } catch (e) {
            reject(e);
        }
    });
}

describe('csrfState', () => {
    it('does nothing when no session', async () => {
        const req = fakeReq({ session: null });
        const res = fakeRes();
        await runMw(csrfState, req, res);
        expect(res.locals.csrfToken).toBeNull();
    });

    it('generates token on first request and persists in session', async () => {
        const session = {};
        const req = fakeReq({ session });
        const res = fakeRes();
        await runMw(csrfState, req, res);
        expect(typeof res.locals.csrfToken).toBe('string');
        expect(res.locals.csrfToken.length).toBeGreaterThan(20);
        expect(session.csrf).toBe(res.locals.csrfToken);
    });

    it('reuses existing token on subsequent requests', async () => {
        const session = {};
        const req = fakeReq({ session });
        const res = fakeRes();
        await runMw(csrfState, req, res);
        const first = res.locals.csrfToken;

        const req2 = fakeReq({ session });
        const res2 = fakeRes();
        await runMw(csrfState, req2, res2);
        expect(res2.locals.csrfToken).toBe(first);
    });
});

describe('csrfGuard', () => {
    it('allows GET requests without check', async () => {
        const req = fakeReq({ method: 'GET' });
        await runMw(csrfGuard, req, fakeRes());
        // ok если не throw
    });

    it('allows POST without session', async () => {
        const req = fakeReq({ method: 'POST', session: null });
        await runMw(csrfGuard, req, fakeRes());
    });

    it('allows POST with session but no csrf yet (initial state)', async () => {
        // session есть, но csrf ещё не выставлен — guard пропускает.
        const req = fakeReq({ method: 'POST', session: {} });
        await runMw(csrfGuard, req, fakeRes());
    });

    it('rejects POST when token missing', async () => {
        const req = fakeReq({
            method: 'POST',
            session: { csrf: 'abc' },
            body: {},
        });
        await expect(runMw(csrfGuard, req, fakeRes())).rejects.toMatchObject({
            status: 403,
        });
    });

    it('rejects POST when token mismatches', async () => {
        const req = fakeReq({
            method: 'POST',
            session: { csrf: 'abc' },
            body: { _csrf: 'wrong' },
        });
        await expect(runMw(csrfGuard, req, fakeRes())).rejects.toMatchObject({
            status: 403,
        });
    });

    it('accepts POST with valid token in body', async () => {
        const req = fakeReq({
            method: 'POST',
            session: { csrf: 'abc' },
            body: { _csrf: 'abc' },
        });
        await runMw(csrfGuard, req, fakeRes());
    });

    it('accepts POST with valid token in X-CSRF-Token header', async () => {
        const req = fakeReq({
            method: 'POST',
            session: { csrf: 'abc' },
            headers: { 'x-csrf-token': 'abc' },
        });
        await runMw(csrfGuard, req, fakeRes());
    });

    it('rejects PUT/DELETE same as POST', async () => {
        for (const method of ['PUT', 'DELETE', 'PATCH']) {
            const req = fakeReq({
                method,
                session: { csrf: 'abc' },
                body: { _csrf: 'wrong' },
            });
            await expect(runMw(csrfGuard, req, fakeRes())).rejects.toMatchObject({
                status: 403,
            });
        }
    });
});
