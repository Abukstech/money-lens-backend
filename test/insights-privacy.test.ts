import { afterEach, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '../src/common/config';
import { hashToken, Privacy } from '../src/common/privacy';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'moneylens-openai-approval-'));
  dirs.push(dir);
  const keys = generateKeyPairSync('ed25519');
  const config = new Config();
  Object.assign(config.values, {
    NODE_ENV: 'production',
    OPENAI_API_KEY: 'synthetic-openai-key',
    OPENAI_ORGANIZATION_ID: 'org-synthetic',
    OPENAI_PROJECT_ID: 'proj-synthetic',
    OPENAI_EVIDENCE_PATH: join(dir, 'openai.json'),
    PROVIDER_EVIDENCE_PUBLIC_KEY_PATH: join(dir, 'approver.pub'),
  });
  writeFileSync(
    config.values.PROVIDER_EVIDENCE_PUBLIC_KEY_PATH!,
    keys.publicKey.export({ format: 'pem', type: 'spki' }),
  );
  const payload = JSON.stringify({
    provider: 'openai',
    organizationId: 'org-synthetic',
    projectId: 'proj-synthetic',
    apiKeySha256: hashToken('synthetic-openai-key'),
    approvedBy: 'reviewer',
    confirmationReference: 'actual-review-reference-required',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    model: config.values.OPENAI_INSIGHTS_MODEL,
    endpoint: '/v1/responses',
    zeroRetentionConfirmed: true,
    processingTermsReviewed: true,
    ...overrides,
  });
  writeFileSync(
    config.values.OPENAI_EVIDENCE_PATH!,
    JSON.stringify({
      payload,
      signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64'),
    }),
  );
  return config;
}
it('accepts OpenAI approval only when the organization, project, key, model and ZDR match', () =>
  expect(() => new Privacy(setup()).verifyProvider('openai')).not.toThrow());
for (const mismatch of [
  { organizationId: 'wrong-org' },
  { projectId: 'wrong-project' },
  { model: 'unapproved-model' },
  { apiKeySha256: '0'.repeat(64) },
  { zeroRetentionConfirmed: false },
  { expiresAt: '2020-01-01T00:00:00Z' },
  { endpoint: '/v1/chat/completions' },
])
  it(`rejects mismatched OpenAI approval ${Object.keys(mismatch)[0]}`, () =>
    expect(() => new Privacy(setup(mismatch)).verifyProvider('openai')).toThrow(
      'PROVIDER_PRIVACY_EVIDENCE_REQUIRED',
    ));
it('blocks production OpenAI use when approval is absent', () => {
  const c = setup();
  c.values.OPENAI_EVIDENCE_PATH = undefined;
  expect(() => new Privacy(c).verifyProvider('openai')).toThrow(
    'PROVIDER_PRIVACY_EVIDENCE_REQUIRED',
  );
});
