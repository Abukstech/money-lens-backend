
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readPdf } from '../src/statements/extraction/pdf-reader';
import { detectLines } from '../src/statements/extraction/detector';
import { parseTableLines } from '../src/statements/extraction/table-parser';
import { reconcileTransactions } from '../src/statements/extraction/reconcile';

async function main() {
  const filePath = process.argv[2];
  if (!filePath) throw new Error('PDF file path required');

  const buffer = await readFile(filePath);
  const pages = await readPdf(
    buffer,
    new AbortController().signal,
  );

  const lines = detectLines(pages);
  const parsed = parseTableLines(lines);
  const result = reconcileTransactions(parsed.rows);

  console.log('Financial Reconciliation:', result);

  // Expected results for the synthetic MoneyLens statement
  assert.equal(parsed.rows.length, 30);
  assert.equal(parsed.issues.length, 0);

  assert.equal(result.transactionCount, 30);
  assert.equal(result.order, 'ascending');
  assert.equal(result.totalCredits, '979800.00');
  assert.equal(result.totalDebits, '890250.00');
  assert.equal(result.inferredOpeningBalance, '185000.00');
  assert.equal(result.closingBalance, '274550.00');

  assert.equal(result.checkedPairs, 29);
  assert.deepEqual(result.issues, []);
  assert.equal(result.reconciled, true);

  console.log('All financial reconciliation checks passed.');
}

main().catch(error => {
  console.error('Reconciliation test failed:', error);
  process.exitCode = 1;
});
