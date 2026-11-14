
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readPdf } from '../src/statements/extraction/pdf-reader';
import { detectLines } from '../src/statements/extraction/detector';
import { parseTableLines } from '../src/statements/extraction/table-parser';

async function main() {
  const path = process.argv[2];

  if (!path) {
    throw new Error('Provide a PDF file path');
  }

  const buffer = await readFile(path);
  const signal = new AbortController().signal;

  const pages = await readPdf(buffer, signal);
  const lines = detectLines(pages);
  const result = parseTableLines(lines);

  console.log('Transaction Parsing Results:', {
    totalPages: pages.length,
    extractedTransactions: result.rows.length,
    page1: result.rows.filter(r => r.page === 0).length,
    page2: result.rows.filter(r => r.page === 1).length,
    issues: result.issues,
  });

  // Assertions for our known synthetic test statement.
  assert.equal(result.rows.length, 30);
  assert.equal(result.issues.length, 0);

  assert.equal(result.rows[0].amount, '850000.00');
  assert.equal(result.rows[0].direction, 'credit');
  assert.equal(result.rows[0].balance, '1035000.00');

  assert.equal(result.rows[13].amount, '9800.00');
  assert.equal(result.rows[13].direction, 'credit');

  assert.equal(result.rows[22].amount, '120000.00');
  assert.equal(result.rows[22].direction, 'credit');

  assert.equal(result.rows[29].amount, '11000.00');
  assert.equal(result.rows[29].balance, '274550.00');

  console.log('All transaction parser assertions passed.');
}

main().catch(error => {
  console.error('Transaction parser test failed:', error);
  process.exitCode = 1;
});
