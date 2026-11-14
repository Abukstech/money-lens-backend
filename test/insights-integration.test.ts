import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/bootstrap';
import { Db } from '../src/common/db';
import { Config } from '../src/common/config';
import { AuthService } from '../src/auth/auth';
import { InsightsSessions } from '../src/insights/sessions';
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const draft = () => ({
  narrative:
    'Based on recorded expenses of {{net_expenses}}, your remaining amount after known allocations is {{remaining_after_known_allocations}}. This is not actual savings. Review flexible dining costs before deciding on changes.',
  findings: [
    {
      observation: 'Dining is {{expenses.dining}}.',
      evidenceIds: ['expenses.dining'],
      consequence: 'This spending uses funds that could support your stated goal.',
      suggestedAction: 'Check which dining costs are flexible for you.',
      assumptions: ['Other spending stays unchanged.'],
      missingContext: [],
    },
  ],
  actions: [],
  limitations: [],
  questions: [],
});
const providerReply = (value: unknown = draft()) =>
  new Response(
    JSON.stringify({
      status: 'completed',
      model: 'gpt-5.4-mini-2026-03-17',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] },
      ],
      usage: { input_tokens: 100, output_tokens: 100 },
    }),
  );
integration('insights API, lifecycle and minimized provider payloads', () => {
  let app: INestApplication,
    db: Db,
    owner: string,
    other: string,
    token: string,
    otherToken: string,
    refreshToken: string;
  const emails = [`insights-${randomUUID()}@example.test`, `insights-${randomUUID()}@example.test`];
  const monthly = {
    takeHomeIncome: '500000.00',
    savingsTarget: '50000.00',
    spendingCoverageConfirmed: true,
  };
  beforeAll(async () => {
    app = await createApp();
    await app.init();
    db = app.get(Db);
    const user = await db.user.create({
      data: { email: emails[0], passwordHash: 'not-used-in-fixture' },
    });
    owner = user.id;
    const second = await db.user.create({
      data: { email: emails[1], passwordHash: 'not-used-in-fixture' },
    });
    other = second.id;
    const auth = app.get(AuthService);
    // Fixture sessions exercise the real ownership guard without external email delivery.
    const jwt = await import('jsonwebtoken');
    async function session(userId: string) {
      const sid = await db.session.create({
        data: { userId, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 86400000) },
      });
      return jwt.default.sign({ sid: sid.id }, app.get(Config).values.JWT_SECRET, {
        subject: userId,
        issuer: 'moneylens',
        audience: 'moneylens-api',
        expiresIn: '15m',
      });
    }
    token = await session(owner);
    otherToken = await session(other);
    void auth;
    for (const [id, category, amount, date] of [
      ['housing', 'housing', '380000', '2026-09-01'],
      ['dining', 'dining', '100000', '2026-09-30'],
      ['october', 'shopping', '999999', '2026-10-01'],
    ])
      await db.transaction.create({
        data: {
          userId: owner,
          sourceRow: `fixture:${id}`,
          date: new Date(date),
          description: 'PRIVATE_TRANSACTION_NARRATION_MARKER 0123456789',
          amount,
          direction: 'debit',
          currency: 'NGN',
          category,
          status: 'user_confirmed',
          source: 'user_confirmed',
          economicType: 'expense',
        },
      });
    await db.transaction.create({
      data: {
        userId: other,
        sourceRow: 'fixture:foreign',
        date: new Date('2026-09-01'),
        description: 'FOREIGN_PRIVATE_NARRATION',
        amount: '999999',
        direction: 'debit',
        category: 'shopping',
        status: 'user_confirmed',
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    if (db) {
      await db.authRateBucket.deleteMany({
        where: { key: { in: [`insights:${owner}`, `insights:${other}`] } },
      });
      await db.user.deleteMany({ where: { email: { in: emails } } });
    }
    if (app) await app.close();
  });
  async function context() {
    await request(app.getHttpServer())
      .put('/api/moneylens/insights/context/2026-09')
      .auth(token, { type: 'bearer' })
      .send(monthly)
      .expect(200);
  }
  function enable() {
    app.get(Config).values.OPENAI_API_KEY = 'synthetic-openai-key';
    const fetch = vi.fn().mockImplementation(async () => providerReply());
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }
  it('requires auth and isolates monthly context by owner', async () => {
    await request(app.getHttpServer()).get('/api/moneylens/insights/context/2026-09').expect(401);
    await context();
    const mine = await request(app.getHttpServer())
      .get('/api/moneylens/insights/context/2026-09')
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(mine.body.takeHomeIncome).toBe('500000.00');
    expect(mine.body).not.toHaveProperty('userId');
    const theirs = await request(app.getHttpServer())
      .get('/api/moneylens/insights/context/2026-09')
      .auth(otherToken, { type: 'bearer' })
      .expect(200);
    expect(theirs.body.takeHomeIncome).toBeNull();
    await request(app.getHttpServer())
      .delete('/api/moneylens/insights/context/2026-09')
      .auth(otherToken, { type: 'bearer' })
      .expect(200);
    expect(await db.monthlyFinancialContext.count({ where: { userId: owner } })).toBe(1);
    await request(app.getHttpServer())
      .delete('/api/moneylens/insights/context/2026-09')
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(await db.monthlyFinancialContext.count({ where: { userId: owner } })).toBe(0);
    await context();
    await request(app.getHttpServer())
      .put('/api/moneylens/insights/context/2026-13')
      .auth(token, { type: 'bearer' })
      .send(monthly)
      .expect(400);
    await request(app.getHttpServer())
      .put('/api/moneylens/insights/context/2026-09')
      .auth(token, { type: 'bearer' })
      .send({ ...monthly, userId: other })
      .expect(400);
  });
  it('scopes facts to calendar month and returns calculated figures without a configured model', async () => {
    await context();
    app.get(Config).values.OPENAI_API_KEY = '';
    const res = await request(app.getHttpServer())
      .post('/api/moneylens/insights/analyze')
      .auth(token, { type: 'bearer' })
      .send({ month: '2026-09' })
      .expect(200);
    expect(res.body.status).toBe('unavailable');
    expect(res.body.facts.metrics.net_expenses.value).toBe('480000.00');
    expect(res.body.facts.metrics.savings_funding_gap.value).toBe('30000.00');
    expect(res.body.narrative).toBeNull();
    expect(res.body.metadata.reasonCode).toBe('OPENAI_NOT_CONFIGURED');
  });
  it('generates a grounded report and sends no transaction details or owner identifiers', async () => {
    const fetch = enable();
    const response = await request(app.getHttpServer())
      .post('/api/moneylens/insights/analyze')
      .auth(token, { type: 'bearer' })
      .send({ month: '2026-09' })
      .expect(200);
    expect(response.body.status).toBe('ready');
    expect(response.body.narrative).toContain('₦480,000.00');
    const body = fetch.mock.calls[0][1].body as string;
    for (const value of [
      owner,
      other,
      emails[0],
      'PRIVATE_TRANSACTION_NARRATION_MARKER',
      '0123456789',
      'FOREIGN_PRIVATE_NARRATION',
    ])
      expect(body).not.toContain(value);
    const tx = await db.transaction.findMany({ where: { userId: owner } });
    for (const row of tx) expect(body).not.toContain(row.id);
    expect(
      JSON.stringify(await db.monthlyFinancialContext.findMany({ where: { userId: owner } })),
    ).not.toContain(response.body.narrative);
  });
  it('keeps unknown transactions out of category accusations and exposes partial analysis', async () => {
    const tx = await db.transaction.create({
      data: {
        userId: owner,
        sourceRow: 'pending-fixture',
        date: new Date('2026-09-15'),
        description: 'UNKNOWN_PRIVATE_RECIPIENT',
        amount: '10000',
        direction: 'debit',
        category: 'unknown',
        status: 'requires_user_tagging',
      },
    });
    try {
      enable();
      const res = await request(app.getHttpServer())
        .post('/api/moneylens/insights/analyze')
        .auth(token, { type: 'bearer' })
        .send({ month: '2026-09' })
        .expect(200);
      expect(res.body.status).toBe('limited');
      expect(res.body.facts.metrics.unclassified_debits.value).toBe('10000.00');
      expect(res.body.facts.metrics['expenses.dining'].value).toBe('100000.00');
    } finally {
      await db.transaction.delete({ where: { id: tx.id } });
    }
  });
  it('returns a safe failure when the provider invents figures, refuses, or is unavailable', async () => {
    enable();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(providerReply({ ...draft(), narrative: 'You spent ₦999,999.' })),
    );
    const invalid = await request(app.getHttpServer())
      .post('/api/moneylens/insights/analyze')
      .auth(token, { type: 'bearer' })
      .send({ month: '2026-09' })
      .expect(200);
    expect(invalid.body.status).toBe('invalid_output');
    expect(invalid.body.narrative).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status: 'completed',
            model: 'test',
            output: [
              {
                type: 'message',
                content: [{ type: 'refusal', refusal: 'PRIVATE_PROVIDER_REFUSAL' }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        ),
      ),
    );
    const refused = await request(app.getHttpServer())
      .post('/api/moneylens/insights/analyze')
      .auth(token, { type: 'bearer' })
      .send({ month: '2026-09' })
      .expect(200);
    expect(refused.body.status).toBe('refused');
    expect(JSON.stringify(refused.body)).not.toContain('PRIVATE_PROVIDER_REFUSAL');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('PRIVATE_PROVIDER_ERROR', { status: 401 })),
    );
    const unavailable = await request(app.getHttpServer())
      .post('/api/moneylens/insights/analyze')
      .auth(token, { type: 'bearer' })
      .send({ month: '2026-09' })
      .expect(200);
    expect(unavailable.body.status).toBe('unavailable');
    expect(JSON.stringify(unavailable.body)).not.toContain('PRIVATE_PROVIDER_ERROR');
  });
  it('owns conversations, sanitizes questions and refreshes facts after a correction', async () => {
    const fetch = enable();
    const created = await request(app.getHttpServer())
      .post('/api/moneylens/insights/conversations')
      .auth(token, { type: 'bearer' })
      .send({ month: '2026-09' })
      .expect(201);
    const id = created.body.conversationId;
    await request(app.getHttpServer())
      .post(`/api/moneylens/insights/conversations/${id}/messages`)
      .auth(otherToken, { type: 'bearer' })
      .send({ message: 'Read the other user.' })
      .expect(404);
    const message = await request(app.getHttpServer())
      .post(`/api/moneylens/insights/conversations/${id}/messages`)
      .auth(token, { type: 'bearer' })
      .send({
        message:
          'PRIVATE_CHAT_MARKER why dining? My email is person@example.test; account 0123456789.',
      })
      .expect(200);
    expect(message.body.report.narrative).toContain('₦480,000.00');
    expect(fetch.mock.calls[0][1].body).not.toContain('person@example.test');
    expect(fetch.mock.calls[0][1].body).not.toContain('0123456789');
    const dining = await db.transaction.findUniqueOrThrow({
      where: { userId_sourceRow: { userId: owner, sourceRow: 'fixture:dining' } },
    });
    await db.transaction.update({
      where: { id: dining.id },
      data: { amount: '90000', revision: { increment: 1 } },
    });
    try {
      const reply = await request(app.getHttpServer())
        .post(`/api/moneylens/insights/conversations/${id}/messages`)
        .auth(token, { type: 'bearer' })
        .send({ message: 'What changed?' })
        .expect(200);
      expect(reply.body.contextRefreshed).toBe(true);
      expect(reply.body.report.facts.metrics['expenses.dining'].value).toBe('90000.00');
      expect(fetch.mock.calls[1][1].body).not.toContain('PRIVATE_CHAT_MARKER');
    } finally {
      await db.transaction.update({
        where: { id: dining.id },
        data: { amount: '100000', revision: { increment: 1 } },
      });
    }
    await request(app.getHttpServer())
      .delete(`/api/moneylens/insights/conversations/${id}`)
      .auth(token, { type: 'bearer' })
      .expect(200);
  });
  it('enforces the shared per-user rate limit', async () => {
    const config = app.get(Config);
    const previous = config.values.INSIGHTS_REQUESTS_PER_HOUR;
    config.values.INSIGHTS_REQUESTS_PER_HOUR = 1;
    await db.authRateBucket.deleteMany({ where: { key: `insights:${owner}` } });
    try {
      enable();
      await request(app.getHttpServer())
        .post('/api/moneylens/insights/analyze')
        .auth(token, { type: 'bearer' })
        .send({ month: '2026-09' })
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/moneylens/insights/analyze')
        .auth(token, { type: 'bearer' })
        .send({ month: '2026-09' })
        .expect(429);
    } finally {
      config.values.INSIGHTS_REQUESTS_PER_HOUR = previous;
      await db.authRateBucket.deleteMany({ where: { key: `insights:${owner}` } });
    }
  });
  it('persists only monthly context, never conversations or generated report bodies', async () => {
    const tables = await db.$queryRaw<
      { tablename: string }[]
    >`SELECT tablename FROM pg_tables WHERE schemaname='public'`;
    expect(tables.some((t) => /conversation|insightreport|transcript/i.test(t.tablename))).toBe(
      false,
    );
    const snapshot = JSON.stringify({
      context: await db.monthlyFinancialContext.findMany({ where: { userId: owner } }),
      transactions: await db.transaction.findMany({ where: { userId: owner } }),
      history: await db.classificationRevision.findMany({
        where: { transaction: { userId: owner } },
      }),
      tasks: await db.classificationTask.findMany({ where: { transaction: { userId: owner } } }),
    });
    expect(snapshot).not.toContain('PRIVATE_CHAT_MARKER');
    expect(snapshot).not.toContain('Based on recorded expenses');
  });
  it('clears conversation memory on logout and deletes saved context with account deletion', async () => {
    const sessions = app.get(InsightsSessions);
    const chat = sessions.create(owner, '2026-09');
    const { hashToken } = await import('../src/common/privacy');
    refreshToken = 'f'.repeat(96);
    await db.session.create({
      data: {
        userId: owner,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    await request(app.getHttpServer()).post('/api/auth/logout').send({ refreshToken }).expect(201);
    expect(() => sessions.current(owner, chat.conversationId)).toThrow('CONVERSATION_NOT_FOUND');
    const newChat = sessions.create(owner, '2026-09');
    await request(app.getHttpServer())
      .delete('/api/auth/account')
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(await db.monthlyFinancialContext.count({ where: { userId: owner } })).toBe(0);
    expect(() => sessions.current(owner, newChat.conversationId)).toThrow();
  });
});
