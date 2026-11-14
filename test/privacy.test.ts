import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Request } from 'express';
import { Config } from '../src/common/config';
import { hashToken, Privacy } from '../src/common/privacy';
import { readUpload } from '../src/statements/upload';
import { Capacity } from '../src/common/concurrency';
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe('production privacy gate', () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'moneylens-approval-'));
    dirs.push(dir);
    const keys = generateKeyPairSync('ed25519');
    writeFileSync(
      join(dir, 'approver.pub'),
      keys.publicKey.export({ format: 'pem', type: 'spki' }),
    );
    const config = new Config();
    config.values.NODE_ENV = 'production';
    config.values.MISTRAL_ORGANIZATION_ID = 'synthetic-org';
    config.values.MISTRAL_API_KEY = 'synthetic-key';
    config.values.ZDR_EVIDENCE_PATH = join(dir, 'mistral.json');
    config.values.PROVIDER_EVIDENCE_PUBLIC_KEY_PATH = join(dir, 'approver.pub');
    function approve(overrides: Record<string, unknown> = {}) {
      const payload = JSON.stringify({
        provider: 'mistral',
        organizationId: 'synthetic-org',
        apiKeySha256: hashToken('synthetic-key'),
        approvedBy: 'synthetic-reviewer',
        confirmationReference: 'synthetic-support-reference',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        model: 'mistral-ocr-latest',
        endpoint: '/v1/ocr',
        zeroRetentionConfirmed: true,
        processingTermsReviewed: true,
        ...overrides,
      });
      writeFileSync(
        config.values.ZDR_EVIDENCE_PATH!,
        JSON.stringify({
          payload,
          signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64'),
        }),
      );
    }
    return { config, approve };
  }
  it('blocks production without a signed approval record', () => {
    const { config } = setup();
    expect(() => new Privacy(config).verifyProvider('mistral')).toThrow(
      'PROVIDER_PRIVACY_EVIDENCE_REQUIRED',
    );
  });
  it('accepts signed, unexpired approval matching the key, organization, model and endpoint', () => {
    const { config, approve } = setup();
    approve();
    expect(() => new Privacy(config).verifyProvider('mistral')).not.toThrow();
  });
  for (const overrides of [
    { expiresAt: '2020-01-01T00:00:00Z' },
    { zeroRetentionConfirmed: false },
    { organizationId: 'wrong-org' },
    { model: 'unapproved-model' },
    { endpoint: '/v1/files' },
    { apiKeySha256: '0'.repeat(64) },
  ])
    it(`rejects mismatched approval ${Object.keys(overrides)[0]}`, () => {
      const { config, approve } = setup();
      approve(overrides);
      expect(() => new Privacy(config).verifyProvider('mistral')).toThrow(
        'PROVIDER_PRIVACY_EVIDENCE_REQUIRED',
      );
    });
  it('rejects a forged signature', () => {
    const { config } = setup();
    writeFileSync(
      config.values.ZDR_EVIDENCE_PATH!,
      JSON.stringify({ payload: '{}', signature: Buffer.alloc(64).toString('base64') }),
    );
    expect(() => new Privacy(config).verifyProvider('mistral')).toThrow();
  });
});
describe('upload lifecycle', () => {
  it('rejects an unfinished file with the wrong field name without an unhandled stream error', async () => {
    const stream = new PassThrough();
    const req = Object.assign(stream, {
      headers: { 'content-type': 'multipart/form-data; boundary=synthetic' },
    }) as unknown as Request;
    const result = readUpload(req, 1000, new AbortController().signal);
    stream.write(
      '--synthetic\r\nContent-Disposition: form-data; name="file"; filename="private.pdf"\r\n\r\n%PDF-PRIVATE_DOCUMENT',
    );
    await expect(result).rejects.toThrow('INVALID_UPLOAD');
    // Busboy emits the rejected file's error on the next tick during teardown.
    await new Promise<void>((resolve) => setImmediate(resolve));
    stream.destroy();

    const next = new PassThrough();
    const nextReq = Object.assign(next, { headers: req.headers }) as unknown as Request;
    const nextResult = readUpload(nextReq, 1000, new AbortController().signal);
    next.end(
      '--synthetic\r\nContent-Disposition: form-data; name="document"; filename="fixture.pdf"\r\n\r\n%PDF-FIXTURE\r\n--synthetic--\r\n',
    );
    await expect(nextResult).resolves.toEqual(Buffer.from('%PDF-FIXTURE'));
  });

  it('aborts an incomplete multipart stream without waiting for the client to finish', async () => {
    const stream = new PassThrough();
    const req = Object.assign(stream, {
      headers: { 'content-type': 'multipart/form-data; boundary=synthetic' },
    }) as unknown as Request;
    const controller = new AbortController();
    const result = readUpload(req, 1000, controller.signal);
    stream.write(
      '--synthetic\r\nContent-Disposition: form-data; name="document"; filename="private.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-PRIVATE_DOCUMENT',
    );
    controller.abort();
    await expect(result).rejects.toThrow('EXTRACTION_CANCELLED');
    stream.destroy(new Error('synthetic client disconnect'));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  it('enforces file size in memory', async () => {
    const stream = new PassThrough();
    const req = Object.assign(stream, {
      headers: { 'content-type': 'multipart/form-data; boundary=synthetic' },
    }) as unknown as Request;
    const result = readUpload(req, 8, new AbortController().signal);
    stream.end(
      '--synthetic\r\nContent-Disposition: form-data; name="document"; filename="private.pdf"\r\n\r\n%PDF-TOO_LONG\r\n--synthetic--\r\n',
    );
    await expect(result).rejects.toThrow('UPLOAD_TOO_LARGE');
  });
  it('releases capacity exactly once', () => {
    const capacity = new Capacity(1);
    const release = capacity.acquire();
    expect(() => capacity.acquire()).toThrow();
    release();
    release();
    expect(() => capacity.acquire()).not.toThrow();
  });
});
