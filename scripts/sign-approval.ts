import { readFileSync } from 'node:fs';
import { sign } from 'node:crypto';
import { z } from 'zod';
import { hashToken } from '../src/common/privacy';
// Run in a separate approval environment. Never mount the signing key into the API.
const args = z
  .object({
    provider: z.enum(['mistral', 'jev', 'openai']),
    organizationId: z.string().min(1),
    projectId: z.string().min(1).optional(),
    approvedBy: z.string().min(1),
    confirmationReference: z.string().min(1),
    expiresAt: z.string().datetime(),
    model: z.string().min(1),
    zeroRetentionConfirmed: z.boolean(),
    processingTermsReviewed: z.literal(true),
  })
  .strict();
try {
  const metadata = args.parse(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  const privateKey = readFileSync(process.argv[3], 'utf8');
  const apiKey = process.env.APPROVED_PROVIDER_API_KEY;
  if (!apiKey) throw new Error();
  const payload = JSON.stringify({
    ...metadata,
    apiKeySha256: hashToken(apiKey),
    endpoint:
      metadata.provider === 'openai'
        ? '/v1/responses'
        : metadata.provider === 'mistral'
          ? '/v1/ocr'
          : '/v1/systemone',
  });
  console.log(
    JSON.stringify({
      payload,
      signature: sign(null, Buffer.from(payload), privateKey).toString('base64'),
    }),
  );
} catch {
  process.stderr.write('APPROVAL_SIGNING_FAILED\n');
  process.exitCode = 1;
}
