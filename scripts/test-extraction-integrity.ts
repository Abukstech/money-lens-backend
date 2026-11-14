
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { readPdf } from '../src/statements/extraction/pdf-reader';
import { detectLines } from '../src/statements/extraction/detector';
import { parseTableLines } from '../src/statements/extraction/table-parser';
import { reconcileTransactions } from '../src/statements/extraction/reconcile';

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error('PDF path required');

  const buffer = await readFile(path);
  const pages = await readPdf(
    buffer,
    new AbortController().signal,
  );

  const parsed = parseTableLines(detectLines(pages));
  const original = parsed.rows;

  assert.equal(original.length, 30);
  assert.equal(reconcileTransactions(original).reconciled, true);

  // Test 1: Incorrect transaction amount
  const altered = original.map(row => ({ ...row }));
  altered[5].amount = '99999.00';

  const amountResult = reconcileTransactions(altered);

  assert.equal(amountResult.reconciled, false);

  console.log('PASS: Incorrect amount detected');

  // Test 2: Missing transaction in the middle
  const missingMiddle = original.filter((_, i) => i !== 10);

  const missingResult = reconcileTransactions(missingMiddle);

  assert.equal(missingResult.reconciled, false);

  console.log('PASS: Missing middle transaction detected');

  // Test 3: Wrong transaction direction
  const wrongDirection = original.map(row => ({ ...row }));

  wrongDirection[7].direction =
    wrongDirection[7].direction === 'debit'
      ? 'credit'
      : 'debit';

  const directionResult = reconcileTransactions(wrongDirection);

  assert.equal(directionResult.reconciled, false);

  console.log('PASS: Incorrect direction detected');

  // Test 4: Missing first transaction
  const missingFirst = original.slice(1);

  const firstResult = reconcileTransactions(missingFirst);

  console.log('Missing first transaction:', {
    reconciled: firstResult.reconciled,
    issues: firstResult.issues,
  });

  // This illustrates the current limitation:
  // reconciliation alone may not detect missing boundary rows.
  if (firstResult.reconciled) {
    console.warn(
      'KNOWN GAP: Missing first transaction was not detected.',
    );
  }

  console.log('Integrity diagnostic tests completed.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
