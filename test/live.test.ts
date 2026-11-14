import { expect, it } from 'vitest';
import { Config } from '../src/common/config';
import { Privacy } from '../src/common/privacy';
import { JevClient } from '../src/classification/jev';
import { OcrClient } from '../src/statements/ocr';
const live = process.env.RUN_LIVE_SMOKE === 'true' ? it : it.skip;
live(
  'opt-in synthetic Jev request',
  async () => {
    const config = new Config();
    config.values.JEV_API_KEY = process.env.LIVE_JEV_API_KEY;
    const answer = await new JevClient(config, new Privacy(config)).classify(
      {
        description: 'NIP TRANSFER TO UNKNOWN RECIPIENT',
        direction: 'debit',
        currency: 'NGN',
        channel: 'bank_transfer',
        isTransfer: true,
        isPossibleReversal: false,
        merchantEvidence: [],
        intermediaryNames: [],
      },
      () => undefined,
    );
    expect(['unknown', 'transfer_unknown']).toContain(answer.category);
  },
  60000,
);
live(
  'opt-in synthetic image OCR request',
  async () => {
    const config = new Config();
    config.values.MISTRAL_API_KEY = process.env.LIVE_MISTRAL_API_KEY;
    config.values.MISTRAL_OCR_REQUESTS_PER_SECOND ??= 1;
    config.values.MISTRAL_OCR_PAGES_PER_MINUTE ??= 2;
    // A one-pixel synthetic PNG contains no statement or personal data.
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
      'base64',
    );
    const result = await new OcrClient(config, new Privacy(config)).extract(
      image,
      'image/png',
      AbortSignal.timeout(60000),
    );
    expect(result.rows).toEqual([]);
  },
  60000,
);
