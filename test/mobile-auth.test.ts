import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import { INestApplication } from '@nestjs/common';
import { createApp } from '../src/bootstrap';
import { Db } from '../src/common/db';
import { Config } from '../src/common/config';
import { EmailVerification, Mailer } from '../src/auth/email';

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('Mobile email authentication (PostgreSQL, fake mail)', () => {
  let app: INestApplication;
  let db: Db;
  let email: string;
  const emails: string[] = [];
  let delivered: { email: string; code: string }[];
  const password = 'test-only-long-password-123';
  beforeAll(async () => {
    app = await createApp();
    await app.init();
    db = app.get(Db);
  });
  beforeEach(async () => {
    email = `mobile-${randomUUID()}@example.test`;
    emails.push(email);
    delivered = [];
    vi.spyOn(app.get(Mailer), 'assertAvailable').mockImplementation(() => {});
    vi.spyOn(app.get(Mailer), 'sendCode').mockImplementation(async (email, code) => {
      delivered.push({ email, code });
    });
    await db.authRateBucket.deleteMany({ where: { key: { startsWith: 'ip:' } } });
  });
  afterAll(async () => {
    await db.emailChallenge.deleteMany({ where: { email: { in: emails } } });
    await db.authRateBucket.deleteMany({});
    await db.user.deleteMany({ where: { email: { in: emails } } });
    await app.close();
  });
  async function issue(purpose = 'registration', target = email) {
    return request(app.getHttpServer())
      .post('/api/auth/email/request-code')
      .send({ email: target, purpose });
  }
  async function verify(id: string, code: string, purpose = 'registration', target = email) {
    return request(app.getHttpServer())
      .post('/api/auth/email/verify-code')
      .send({ email: target, purpose, challengeId: id, code });
  }
  async function grant(purpose = 'registration') {
    const issued = await issue(purpose);
    expect(issued.status).toBe(201);
    const checked = await verify(issued.body.challengeId, delivered.at(-1)!.code, purpose);
    expect(checked.status).toBe(201);
    return checked.body.grant as string;
  }
  async function register() {
    const registrationGrant = await grant();
    const res = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email, password, registrationGrant });
    expect(res.status).toBe(201);
    return res.body;
  }
  async function unlockResend() {
    await db.authRateBucket.updateMany({
      where: { key: `email:${app.get(EmailVerification).hash(email)}` },
      data: { lastRequestedAt: new Date(Date.now() - 61000) },
    });
  }
  it('requires verification; registers and persists profile without exposing credentials', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email, password })
      .expect(400);
    const tokens = await register();
    const me = await request(app.getHttpServer())
      .patch('/api/auth/me')
      .auth(tokens.accessToken, { type: 'bearer' })
      .send({ firstName: '  Chidera  ' })
      .expect(200);
    expect(me.body).toEqual({
      userId: expect.any(String),
      email,
      firstName: 'Chidera',
      emailVerifiedAt: expect.any(String),
    });
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password })
      .expect(201);
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .auth(login.body.accessToken, { type: 'bearer' })
      .expect(200);
  });
  it('completes registration with the real console delivery adapter in development', async () => {
    vi.mocked(app.get(Mailer).assertAvailable).mockRestore();
    vi.mocked(app.get(Mailer).sendCode).mockRestore();
    const config = app.get(Config);
    const previousMode = config.values.EMAIL_DELIVERY_MODE;
    const previousEnvironment = config.values.NODE_ENV;
    config.values.NODE_ENV = 'development';
    config.values.EMAIL_DELIVERY_MODE = 'console';
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      const issued = await issue();
      expect(issued.status).toBe(201);
      const line = write.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.startsWith('[MoneyLens development email]'))!;
      const logged = JSON.parse(line.slice(line.indexOf('{')));
      expect(logged.code).toMatch(/^\d{6}$/);
      expect(logged.challengeId).toBe(issued.body.challengeId);
      expect(JSON.stringify(issued.body)).not.toContain(logged.code);
      expect(fetch).not.toHaveBeenCalled();
      const verified = await verify(issued.body.challengeId, logged.code);
      expect(verified.status).toBe(201);
      await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({ email, password, registrationGrant: verified.body.grant })
        .expect(201);
    } finally {
      config.values.NODE_ENV = previousEnvironment;
      config.values.EMAIL_DELIVERY_MODE = previousMode;
    }
  });
  it('stores a keyed code hash, never the code or grant, and consumes each once', async () => {
    const issued = await issue();
    const code = delivered[0].code;
    const stored = await db.emailChallenge.findUniqueOrThrow({
      where: { id: issued.body.challengeId },
    });
    expect(stored.codeHash).not.toBe(code);
    expect(stored.codeHash).toHaveLength(64);
    expect(JSON.stringify(issued.body)).not.toContain(code);
    const checked = await verify(stored.id, code);
    expect(checked.status).toBe(201);
    await verify(stored.id, code).then((res) => expect(res.status).toBe(401));
    const args = { email, password, registrationGrant: checked.body.grant };
    const results = await Promise.all(
      [1, 2].map(() => request(app.getHttpServer()).post('/api/auth/register').send(args)),
    );
    expect(results.map((res) => res.status).sort()).toEqual([201, 401]);
  });
  it('expires codes and grants', async () => {
    const issued = await issue();
    await db.emailChallenge.update({
      where: { id: issued.body.challengeId },
      data: { expiresAt: new Date(0) },
    });
    expect((await verify(issued.body.challengeId, delivered[0].code)).status).toBe(401);
    await unlockResend();
    const registrationGrant = await grant();
    await db.emailChallenge.updateMany({ where: { email }, data: { grantExpiresAt: new Date(0) } });
    await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email, password, registrationGrant })
      .expect(401);
  });
  it('limits attempts to five even when the sixth attempt is correct', async () => {
    const issued = await issue();
    const code = delivered[0].code;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++)
      expect((await verify(issued.body.challengeId, wrong)).status).toBe(401);
    expect((await verify(issued.body.challengeId, code)).status).toBe(401);
    expect(
      (await db.emailChallenge.findUniqueOrThrow({ where: { id: issued.body.challengeId } }))
        .attempts,
    ).toBe(5);
  });
  it('enforces cooldown, invalidates the earlier challenge on resend, and limits email requests', async () => {
    const first = await issue();
    const oldCode = delivered[0].code;
    expect((await issue()).status).toBe(429);
    await unlockResend();
    const second = await issue();
    expect(second.status).toBe(201);
    expect((await verify(first.body.challengeId, oldCode)).status).toBe(401);
    for (let i = 0; i < 3; i++) {
      await unlockResend();
      expect((await issue()).status).toBe(201);
    }
    await unlockResend();
    expect((await issue()).status).toBe(429);
  });
  it('enforces the shared IP request limit', async () => {
    await db.authRateBucket.create({
      data: {
        key: `ip:${app.get(EmailVerification).hash('::ffff:127.0.0.1')}`,
        count: 30,
        windowStartedAt: new Date(),
        lastRequestedAt: new Date(),
      },
    });
    // Exercise service explicitly so the test is independent of supertest IPv4/IPv6 binding.
    await expect(
      app.get(EmailVerification).request(email, 'registration', '::ffff:127.0.0.1'),
    ).rejects.toMatchObject({ status: 429 });
  });
  it('does not send mail for unknown reset accounts and returns the same response shape', async () => {
    const unknown = await issue('password_reset');
    expect(unknown.status).toBe(201);
    expect(delivered).toHaveLength(0);
    expect(Object.keys(unknown.body).sort()).toEqual(['challengeId', 'expiresIn', 'resendAfter']);
    expect((await verify(unknown.body.challengeId, '000000', 'password_reset')).status).toBe(401);
  });
  it('scopes grants to purpose and email, resets the password, and revokes all sessions', async () => {
    const tokens = await register();
    await unlockResend();
    const resetGrant = await grant('password_reset');
    await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email, password, registrationGrant: resetGrant })
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/auth/password/reset')
      .send({ email: 'other@example.test', password, grant: resetGrant })
      .expect(401);
    const nextPassword = 'different-test-password-123';
    await request(app.getHttpServer())
      .post('/api/auth/password/reset')
      .send({ email, password: nextPassword, grant: resetGrant })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/auth/password/reset')
      .send({ email, password, grant: resetGrant })
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .auth(tokens.accessToken, { type: 'bearer' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken: tokens.refreshToken })
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password })
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: nextPassword })
      .expect(201);
  });
  it('keeps legacy accounts usable and protects profile ownership', async () => {
    const legacy = await db.user.create({
      data: { email, passwordHash: await argon2.hash(password) },
    });
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password })
      .expect(201);
    await request(app.getHttpServer())
      .patch('/api/auth/me')
      .send({ firstName: 'Intruder' })
      .expect(401);
    await request(app.getHttpServer())
      .patch('/api/auth/me')
      .auth(login.body.accessToken, { type: 'bearer' })
      .send({ firstName: '', userId: 'other' })
      .expect(400);
    expect((await db.user.findUniqueOrThrow({ where: { id: legacy.id } })).firstName).toBeNull();
  });
  it('deletes verification records with the account and cascades live data', async () => {
    const tokens = await register();
    await request(app.getHttpServer())
      .delete('/api/auth/account')
      .auth(tokens.accessToken, { type: 'bearer' })
      .expect(200);
    expect(await db.emailChallenge.count({ where: { email } })).toBe(0);
    expect(await db.user.count({ where: { email } })).toBe(0);
  });
  it('returns a safe delivery failure and does not leave a usable challenge', async () => {
    vi.spyOn(app.get(Mailer), 'sendCode').mockRejectedValueOnce(
      new Error('PRIVATE_PROVIDER_ERROR'),
    );
    const response = await issue();
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE_PROVIDER_ERROR');
    expect(await db.emailChallenge.count({ where: { email } })).toBe(0);
  });
});
