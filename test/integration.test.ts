import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { INestApplication } from '@nestjs/common';
import { createApp } from '../src/bootstrap';
import { Db } from '../src/common/db';
import { Classifier } from '../src/classification/classifier';
import { ClassificationJobs } from '../src/classification/jobs';
import { Config } from '../src/common/config';
import { Statements } from '../src/statements/service';
import { ExtractionDraftService } from '../src/statements/extraction/extraction-draft.service';
import { EmailVerification } from '../src/auth/email';
import { randomBytes, randomUUID } from 'node:crypto';

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration('PostgreSQL API and privacy integration', () => {
  let app: INestApplication;
  let db: Db;
  let userId: string;
  let token: string;
  let refreshToken: string;
  let secondToken: string;
  const emails = [
    `integration-${randomUUID()}@example.test`,
    `integration-${randomUUID()}@example.test`,
  ];
  const row = {
    date: '2026-10-15',
    description: 'POS SPAR 0123456789',
    amount: '125.10',
    direction: 'debit',
    currency: 'NGN',
    balance: '874.90',
    page: 0,
    row: 0,
  };
  const secondRow = {
    ...row,
    date: '2026-10-16',
    description: 'ATM CASH',
    amount: '10.00',
    balance: '864.90',
    row: 1,
  };

  async function statementPdf(layout: 'local' | 'unfamiliar' | 'scan', title = 'Statement') {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([810, 600]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    if (layout === 'scan') {
      const image = await pdf.embedPng(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
      );
      page.drawImage(image, { x: 45, y: 220, width: 700, height: 280 });
    } else {
      page.drawText(title, { x: 45, y: 550, font, size: 14, color: rgb(0, 0, 0) });
      const columns = [45, 220, 520, 700];
      const draw = (cells: string[], y: number) => {
        cells.forEach((text, i) => page.drawText(text, { x: columns[i], y, font, size: 10 }));
      };
      if (layout === 'local') draw(['Date', 'Narration', 'Amount (NGN)', 'Balance'], 500);
      draw(['15/10/2026', row.description, '-125.10', '874.90'], 470);
      draw(['16/10/2026', secondRow.description, '-10.00', '864.90'], 442);
    }
    return Buffer.from(await pdf.save());
  }

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    db = app.get(Db);
    app.get(Config).values.MISTRAL_OCR_REQUESTS_PER_SECOND = 1000;
    app.get(Config).values.MISTRAL_OCR_PAGES_PER_MINUTE = 1000;
    async function registrationGrant(email: string) {
      const grant = randomBytes(48).toString('hex');
      await db.emailChallenge.create({
        data: {
          email,
          purpose: 'registration',
          eligible: true,
          codeHash: 'fixture',
          expiresAt: new Date(Date.now() + 600000),
          consumedAt: new Date(),
          grantHash: app.get(EmailVerification).hash(grant),
          grantExpiresAt: new Date(Date.now() + 600000),
        },
      });
      return grant;
    }
    const first = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({
        email: emails[0],
        password: 'synthetic-test-password-123',
        registrationGrant: await registrationGrant(emails[0]),
      })
      .expect(201);
    token = first.body.accessToken;
    refreshToken = first.body.refreshToken;
    userId = (
      await request(app.getHttpServer())
        .get('/api/auth/me')
        .auth(token, { type: 'bearer' })
        .expect(200)
    ).body.userId;
    const second = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({
        email: emails[1],
        password: 'synthetic-other-password-123',
        registrationGrant: await registrationGrant(emails[1]),
      })
      .expect(201);
    secondToken = second.body.accessToken;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    app.get(Config).values.MISTRAL_OCR_ENABLED = false;
  });
  afterAll(async () => {
    if (db) await db.emailChallenge.deleteMany({ where: { email: { in: emails } } });
    if (db) await db.statementExtractionDraft.deleteMany({ where: { createdByUserId: userId } });
    if (db) await db.user.deleteMany({ where: { email: { in: emails } } });
    if (app) await app.close();
  });
  async function submit(description: string, extra: Record<string, unknown> = {}) {
    const input = {
      id: randomUUID(),
      date: '2026-10-15',
      amount: '45000.10',
      direction: 'debit',
      description,
      ...extra,
    };
    const res = await request(app.getHttpServer())
      .post('/api/moneylens/transactions/classify')
      .auth(token, { type: 'bearer' })
      .send(input)
      .expect(202);
    return { id: res.body.transactionId, input };
  }
  function ocrReply(rows: unknown[] = [row, secondRow]) {
    return new Response(
      JSON.stringify({
        document_annotation: JSON.stringify({ transactions: rows }),
        pages: [{ index: 0, markdown: 'RAW_OCR_DO_NOT_PERSIST_MARKER' }],
        images: [{ data: 'RAW_IMAGE_MARKER' }],
      }),
    );
  }
  it('allows the configured browser origin and authorization preflight only', async () => {
    const response = await request(app.getHttpServer())
      .options('/api/auth/login')
      .set('Origin', 'http://localhost:8089')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,authorization')
      .expect(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:8089');
    expect(response.headers['access-control-allow-headers']).toContain('authorization');
    const other = await request(app.getHttpServer())
      .get('/api/health')
      .set('Origin', 'http://untrusted.example')
      .expect(200);
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('serves documented OpenAPI and YAML contracts in development/test', async () => {
    const json = await request(app.getHttpServer()).get('/api/openapi.json').expect(200);
    expect(json.body.paths['/api/moneylens/statements/extract']).toBeDefined();
    const yaml = await request(app.getHttpServer()).get('/api/docs-yaml').expect(200);
    expect(yaml.text).toContain('MoneyLens');
  });
  it('enforces authentication, no-store and ownership', async () => {
    await request(app.getHttpServer()).get('/api/moneylens/transactions').expect(401);
    const t = await submit('POS SPAR');
    await request(app.getHttpServer())
      .get(`/api/moneylens/transactions/${t.id}`)
      .auth(secondToken, { type: 'bearer' })
      .expect(404);
    const res = await request(app.getHttpServer())
      .get(`/api/moneylens/transactions/${t.id}`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
  it('rotates refresh tokens atomically and revokes their access session', async () => {
    const rotated = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken })
      .expect(201);
    await request(app.getHttpServer()).post('/api/auth/refresh').send({ refreshToken }).expect(401);
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .auth(token, { type: 'bearer' })
      .expect(401);
    token = rotated.body.accessToken;
    refreshToken = rotated.body.refreshToken;
  });
  it('is idempotent without collapsing legitimate identical transactions', async () => {
    const first = await submit('POS LOCAL MARKET');
    const again = await request(app.getHttpServer())
      .post('/api/moneylens/transactions/classify')
      .auth(token, { type: 'bearer' })
      .send(first.input)
      .expect(202);
    expect(again.body.transactionId).toBe(first.id);
    const different = await submit('POS LOCAL MARKET');
    expect(different.id).not.toBe(first.id);
    await request(app.getHttpServer())
      .post('/api/moneylens/transactions/classify')
      .auth(token, { type: 'bearer' })
      .send({ ...first.input, amount: '2.00' })
      .expect(409);
  });
  it('persists a suggestion, accepts correction, audits it, and ignores a stale job', async () => {
    const { id } = await submit('POS SPAR');
    await app.get(Classifier).run(id, 0);
    const before = await db.transaction.findUniqueOrThrow({ where: { id } });
    expect(before.category).toBe('unknown');
    expect(before.suggestedCategory).toBe('groceries');
    await request(app.getHttpServer())
      .patch(`/api/moneylens/transactions/${id}/classification`)
      .auth(token, { type: 'bearer' })
      .send({ revision: before.revision, category: 'shopping' })
      .expect(200);
    await app.get(Classifier).run(id, before.revision);
    const after = await db.transaction.findUniqueOrThrow({ where: { id } });
    expect(after.category).toBe('shopping');
    expect(after.status).toBe('user_confirmed');
    expect(await db.classificationRevision.count({ where: { transactionId: id } })).toBe(2);
    await request(app.getHttpServer())
      .patch(`/api/moneylens/transactions/${id}/classification`)
      .auth(token, { type: 'bearer' })
      .send({ revision: before.revision, category: 'groceries' })
      .expect(409);
    const summary = await request(app.getHttpServer())
      .get('/api/moneylens/classification/summary')
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(summary.body.categories.shopping).toBe('45000.10');
  });
  it('permits only one concurrent feedback revision', async () => {
    const { id } = await submit('LOCAL PAYMENT');
    const outcomes = await Promise.all(
      ['housing', 'education'].map((category) =>
        request(app.getHttpServer())
          .patch(`/api/moneylens/transactions/${id}/classification`)
          .auth(token, { type: 'bearer' })
          .send({ revision: 0, category }),
      ),
    );
    expect(outcomes.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await db.classificationRevision.count({ where: { transactionId: id } })).toBe(1);
  });
  it('saves user-scoped conditional rules and preserves update/delete history', async () => {
    const { id } = await submit('NIP RENT PAYMENT', { recipientIdentifier: '999:0000000000' });
    await request(app.getHttpServer())
      .patch(`/api/moneylens/transactions/${id}/classification`)
      .auth(token, { type: 'bearer' })
      .send({
        revision: 0,
        category: 'housing',
        rememberForFuture: true,
        conditions: {
          direction: 'debit',
          currency: 'NGN',
          minAmount: '40000',
          maxAmount: '50000',
          narrationTokens: ['RENT'],
        },
      })
      .expect(200);
    const next = await submit('NIP RENT PAYMENT', { recipientIdentifier: '999:0000000000' });
    await app.get(Classifier).run(next.id, 0);
    expect((await db.transaction.findUniqueOrThrow({ where: { id: next.id } })).source).toBe(
      'user_rule',
    );
    const unrelated = await submit('NIP SCHOOL PAYMENT', { recipientIdentifier: '999:0000000000' });
    await app.get(Classifier).run(unrelated.id, 0);
    expect(
      (await db.transaction.findUniqueOrThrow({ where: { id: unrelated.id } })).source,
    ).not.toBe('user_rule');
    const other = await request(app.getHttpServer())
      .post('/api/moneylens/transactions/classify')
      .auth(secondToken, { type: 'bearer' })
      .send({
        id: randomUUID(),
        date: '2026-10-15',
        amount: '45000.10',
        direction: 'debit',
        description: 'NIP RENT PAYMENT',
        recipientIdentifier: '999:0000000000',
      })
      .expect(202);
    await app.get(Classifier).run(other.body.transactionId, 0);
    expect(
      (await db.transaction.findUniqueOrThrow({ where: { id: other.body.transactionId } })).source,
    ).not.toBe('user_rule');
    const rules = await request(app.getHttpServer())
      .get('/api/moneylens/classification/rules')
      .auth(token, { type: 'bearer' })
      .expect(200);
    const rule = rules.body[0];
    expect(rule.recipientHash).toBeUndefined();
    await request(app.getHttpServer())
      .delete(`/api/moneylens/classification/rules/${rule.id}`)
      .auth(secondToken, { type: 'bearer' })
      .send({ version: 1 })
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/api/moneylens/classification/rules/${rule.id}`)
      .auth(token, { type: 'bearer' })
      .send({
        version: 1,
        category: 'housing',
        conditions: {
          direction: 'debit',
          currency: 'NGN',
          minAmount: '42000',
          maxAmount: '48000',
          narrationTokens: ['RENT'],
        },
      })
      .expect(200);
    await request(app.getHttpServer())
      .delete(`/api/moneylens/classification/rules/${rule.id}`)
      .auth(token, { type: 'bearer' })
      .send({ version: 2 })
      .expect(200);
    expect(await db.ruleRevision.count({ where: { ruleId: rule.id } })).toBe(3);
  });
  it('imports locally through both routes without an OCR key', async () => {
    const config = app.get(Config).values;
    const apiKey = config.MISTRAL_API_KEY;
    config.MISTRAL_API_KEY = undefined;
    config.MISTRAL_OCR_ENABLED = true;
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      const file = await statementPdf('local');
      const result = await request(app.getHttpServer())
        .post('/api/moneylens/statements/extract')
        .auth(token, { type: 'bearer' })
        .attach('document', file, 'local.pdf')
        .expect(201);
      expect(result.body.transactionIds).toHaveLength(2);
      const draft = await request(app.getHttpServer())
        .post('/api/moneylens/statements/extraction-drafts')
        .auth(token, { type: 'bearer' })
        .attach('document', file, 'local.pdf')
        .expect(201);
      expect(draft.body.status).toBe('VALIDATED');
      await expect(
        app.get(ExtractionDraftService).getValidatedRowsForClassification(draft.body.id, {
          userId,
          accountScopeId: `user:${userId}`,
        }),
      ).resolves.toHaveLength(2);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      config.MISTRAL_API_KEY = apiKey;
    }
  });

  it('extracts in memory and does not persist raw documents, OCR or filenames', async () => {
    const fetch = vi.fn().mockResolvedValue(ocrReply());
    vi.stubGlobal('fetch', fetch);
    const stderr = vi.spyOn(process.stderr, 'write');
    const stdout = vi.spyOn(process.stdout, 'write');
    app.get(Config).values.MISTRAL_OCR_ENABLED = true;
    const file = await statementPdf('unfamiliar', 'SYNTHETIC_DOCUMENT_DO_NOT_PERSIST_MARKER');
    const res = await request(app.getHttpServer())
      .post('/api/moneylens/statements/extract')
      .auth(token, { type: 'bearer' })
      .attach('document', file, 'PRIVATE_FILENAME_MARKER.pdf')
      .expect(201);
    expect(res.body.documentRetained).toBe(false);
    const id = res.body.transactionIds[0];
    const t = await db.transaction.findUniqueOrThrow({ where: { id } });
    expect(t.description).toBe('POS SPAR [REDACTED]');
    expect(t.amount.toFixed(2)).toBe('125.10');
    const persisted = JSON.stringify({
      statements: await db.statement.findMany({ where: { userId } }),
      transactions: await db.transaction.findMany({ where: { userId } }),
      revisions: await db.classificationRevision.findMany({ where: { transaction: { userId } } }),
      tasks: await db.classificationTask.findMany({ where: { transaction: { userId } } }),
    });
    for (const marker of [
      'SYNTHETIC_DOCUMENT_DO_NOT_PERSIST_MARKER',
      'RAW_OCR_DO_NOT_PERSIST_MARKER',
      'RAW_IMAGE_MARKER',
      'PRIVATE_FILENAME_MARKER',
      '0123456789',
      file.toString('base64'),
    ])
      expect(persisted).not.toContain(marker);
    expect(JSON.stringify(stderr.mock.calls)).not.toContain('MARKER');
    expect(JSON.stringify(stdout.mock.calls)).not.toContain('MARKER');
    const again = await request(app.getHttpServer())
      .post('/api/moneylens/statements/extract')
      .auth(token, { type: 'bearer' })
      .attach('document', file, 'different.pdf')
      .expect(201);
    expect(again.body.id).toBe(res.body.id);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('saves valid OCR rows from scanned PDFs for review and blocks automatic import', async () => {
    const file = await statementPdf('scan');
    const fetch = vi
      .fn()
      .mockImplementation(() =>
        ocrReply([row, secondRow, { ...row, row: 2, amount: 'PRIVATE_INVALID_AMOUNT_MARKER' }]),
      );
    vi.stubGlobal('fetch', fetch);
    app.get(Config).values.MISTRAL_OCR_ENABLED = true;
    const draft = await request(app.getHttpServer())
      .post('/api/moneylens/statements/extraction-drafts')
      .auth(token, { type: 'bearer' })
      .attach('document', file, 'PRIVATE_FILENAME_MARKER.pdf')
      .expect(201);
    expect(draft.body.status).toBe('NEEDS_REVIEW');
    expect(draft.body.transactionCount).toBe(2);
    expect(draft.body.reviewReasons).toEqual(
      expect.arrayContaining(['UNREADABLE_PAGES', 'INCOMPLETE_COVERAGE', 'INVALID_ROWS']),
    );
    const saved = await request(app.getHttpServer())
      .get(`/api/moneylens/statements/extraction-drafts/${draft.body.id}`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(saved.body.rows.map(({ description }: { description: string }) => description)).toEqual([
      'POS SPAR [REDACTED]',
      'ATM CASH',
    ]);
    expect(JSON.stringify(saved.body)).not.toMatch(/MARKER|0123456789/);
    await expect(
      app.get(ExtractionDraftService).getValidatedRowsForClassification(draft.body.id, {
        userId,
        accountScopeId: `user:${userId}`,
      }),
    ).rejects.toThrow('Statement has not passed extraction validation');

    const imported = await request(app.getHttpServer())
      .post('/api/moneylens/statements/extract')
      .auth(token, { type: 'bearer' })
      .attach('document', file, 'scan.pdf')
      .expect(400);
    expect(imported.body.code).toBe('AUTOMATED_EXTRACTION_VALIDATION_FAILED');
    const statement = await db.statement.findFirstOrThrow({
      where: { userId, errorCode: 'AUTOMATED_EXTRACTION_VALIDATION_FAILED' },
    });
    expect(await db.transaction.count({ where: { statementId: statement.id } })).toBe(0);
  });

  it('returns a safe rate-limit response and permits successful reupload after cooldown', async () => {
    const file = await statementPdf('unfamiliar', 'Retry statement');
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Response('PRIVATE_OCR_ERROR_MARKER', {
            status: 429,
            headers: { 'Retry-After': '1' },
          }),
      )
      .mockImplementation(() => ocrReply());
    vi.stubGlobal('fetch', fetch);
    const config = app.get(Config).values;
    config.MISTRAL_OCR_ENABLED = true;
    const deadline = config.OCR_DEADLINE_MS;
    config.OCR_DEADLINE_MS = 500;
    try {
      const response = await request(app.getHttpServer())
        .post('/api/moneylens/statements/extract')
        .auth(token, { type: 'bearer' })
        .attach('document', file, 'retry.pdf')
        .expect(503);
      expect(response.body).toEqual({ statusCode: 503, code: 'OCR_RATE_LIMITED' });
      expect(response.headers['retry-after']).toBe('1');
      expect(response.headers['x-ratelimit-source']).toBe('mistral');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      config.OCR_DEADLINE_MS = deadline;
    }
    const failed = await db.statement.findFirstOrThrow({
      where: { userId, errorCode: 'OCR_RATE_LIMITED' },
    });
    expect(failed.leaseToken).toBeNull();
    expect(failed.leaseExpiresAt).toBeNull();
    const recovered = await request(app.getHttpServer())
      .post('/api/moneylens/statements/extract?retry=true')
      .auth(token, { type: 'bearer' })
      .attach('document', file, 'retry.pdf')
      .expect(201);
    expect(recovered.body.id).toBe(failed.id);
    expect(recovered.body.transactionIds).toHaveLength(2);
  });

  it('rejects reconciled OCR amounts that disagree with the source PDF', async () => {
    const file = await statementPdf('unfamiliar', 'OCR amount verification');
    app.get(Config).values.MISTRAL_OCR_ENABLED = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        ocrReply([
          { ...row, balance: '875.00' },
          { ...secondRow, balance: '865.00' },
        ]),
      ),
    );
    const result = await request(app.getHttpServer())
      .post('/api/moneylens/statements/extraction-drafts')
      .auth(token, { type: 'bearer' })
      .attach('document', file, 'mismatched-amount.pdf')
      .expect(201);
    expect(result.body.status).toBe('NEEDS_REVIEW');
    expect(result.body.reviewReasons).toEqual(['INCOMPLETE_COVERAGE']);
  });

  it('releases extraction capacity and persists a safe status on timeout', async () => {
    const c = app.get(Config).values;
    const original = c.OCR_DEADLINE_MS;
    const file = await statementPdf('unfamiliar', 'Slow OCR');
    c.MISTRAL_OCR_ENABLED = true;
    c.OCR_DEADLINE_MS = 300;
    const fetch = vi.fn().mockImplementation(
      (_url, options: RequestInit) =>
        new Promise((_resolve, reject) =>
          options.signal!.addEventListener('abort', () => reject(new Error('TIMEOUT_SECRET')), {
            once: true,
          }),
        ),
    );
    vi.stubGlobal('fetch', fetch);
    try {
      const res = await request(app.getHttpServer())
        .post('/api/moneylens/statements/extract')
        .auth(token, { type: 'bearer' })
        .attach('document', file, 'timeout.pdf')
        .expect(408);
      expect(res.body.code).toBe('EXTRACTION_CANCELLED');
      expect(JSON.stringify(res.body)).not.toContain('SECRET');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      c.OCR_DEADLINE_MS = original;
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => ocrReply()),
    );
    await request(app.getHttpServer())
      .post('/api/moneylens/statements/extract')
      .auth(token, { type: 'bearer' })
      .attach('document', file, 'after.pdf')
      .expect(201);
  });
  it('rejects extra multipart fields and unsupported file bytes', async () => {
    await request(app.getHttpServer())
      .post('/api/moneylens/statements/extract')
      .auth(token, { type: 'bearer' })
      .field('address', 'PRIVATE_ADDRESS')
      .attach('document', Buffer.from('%PDF-X'), 'x.pdf')
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/moneylens/statements/extract')
      .auth(token, { type: 'bearer' })
      .attach('document', Buffer.from('NOT_A_PDF'), 'x.pdf')
      .expect(400);
  });
  it('runs durable identifier-only jobs through pg-boss', async () => {
    const { id } = await submit('ATM CASH WITHDRAWAL');
    const config = app.get(Config);
    config.values.JOBS_ENABLED = true;
    const jobs = new ClassificationJobs(db, config, app.get(Classifier));
    try {
      await jobs.onModuleInit();
      await vi.waitFor(
        async () =>
          expect((await db.transaction.findUniqueOrThrow({ where: { id } })).category).toBe(
            'cash_withdrawal',
          ),
        { timeout: 15000, interval: 200 },
      );
      const payloads = await db.$queryRaw<
        { data: unknown }[]
      >`SELECT data FROM pgboss.job WHERE name = 'classify-transaction'`;
      for (const { data } of payloads)
        expect(Object.keys(data as object).sort()).toEqual(['taskId', 'transactionId']);
    } finally {
      await jobs.onModuleDestroy();
      config.values.JOBS_ENABLED = false;
    }
  });
  it('links refunds only to a unique matching owned original debit', async () => {
    const original = await submit('POS SPAR', { reference: 'synthetic-refund-reference' });
    const refund = await submit('REFUND', {
      direction: 'credit',
      reference: 'synthetic-refund-reference',
    });
    await app.get(Classifier).run(refund.id, 0);
    const linked = await db.transaction.findUniqueOrThrow({ where: { id: refund.id } });
    expect(linked.category).toBe('refund');
    expect(linked.linkedTransactionId).toBe(original.id);
    expect(
      (await db.classificationRevision.findFirstOrThrow({ where: { transactionId: refund.id } }))
        .linkedTransactionId,
    ).toBe(original.id);
  });
  it('corrects extracted fields with revision checks before classification', async () => {
    const { id } = await submit('LOCAL PAYMENT');
    await request(app.getHttpServer())
      .patch(`/api/moneylens/transactions/${id}/extraction`)
      .auth(token, { type: 'bearer' })
      .send({
        revision: 0,
        date: '2026-10-16',
        amount: '100.01',
        direction: 'debit',
        description: 'ATM CASH',
      })
      .expect(200);
    await app.get(Classifier).run(id, 0);
    expect((await db.transaction.findUniqueOrThrow({ where: { id } })).amount.toFixed(2)).toBe(
      '100.01',
    );
    await app.get(Classifier).run(id, 1);
    expect((await db.transaction.findUniqueOrThrow({ where: { id } })).category).toBe(
      'cash_withdrawal',
    );
  });
  it('clears the lease and persists no rows when the client cancels during OCR', async () => {
    const file = await statementPdf('unfamiliar', 'Cancel OCR');
    const controller = new AbortController();
    app.get(Config).values.MISTRAL_OCR_ENABLED = true;
    const fetch = vi.fn().mockImplementation(
      (_url, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal!.addEventListener(
            'abort',
            () => reject(new Error('CANCELLED_DOCUMENT_MARKER')),
            { once: true },
          );
          controller.abort();
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const promise = app.get(Statements).extract(userId, file, controller.signal);
    await expect(promise).rejects.toThrow('EXTRACTION_CANCELLED');
    expect(fetch).toHaveBeenCalledTimes(1);
    const failed = await db.statement.findFirstOrThrow({
      where: { userId, errorCode: 'EXTRACTION_CANCELLED', leaseToken: null },
      orderBy: { updatedAt: 'desc' },
    });
    expect(await db.transaction.count({ where: { statementId: failed.id } })).toBe(0);
    expect(JSON.stringify(failed)).not.toContain('MARKER');
  });
  it('revokes access on logout', async () => {
    await request(app.getHttpServer()).post('/api/auth/logout').send({ refreshToken }).expect(201);
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .auth(token, { type: 'bearer' })
      .expect(401);
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: emails[0], password: 'synthetic-test-password-123' })
      .expect(201);
    token = login.body.accessToken;
  });
  it('remains document-free across application restart and deletes account data', async () => {
    await app.close();
    app = await createApp();
    await app.init();
    db = app.get(Db);
    const statements = await db.statement.findMany({ where: { userId } });
    expect(JSON.stringify(statements)).not.toContain('MARKER');
    await request(app.getHttpServer())
      .delete('/api/auth/account')
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(await db.transaction.count({ where: { userId } })).toBe(0);
    expect(await db.statement.count({ where: { userId } })).toBe(0);
    expect(await db.recipientRule.count({ where: { userId } })).toBe(0);
    expect(await db.session.count({ where: { userId } })).toBe(0);
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .auth(token, { type: 'bearer' })
      .expect(401);
  });
});
