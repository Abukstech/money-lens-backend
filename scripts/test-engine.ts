
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractStatement } from '../src/statements/extraction/engine';

async function main() {
  const path = process.argv[2];

  if (!path) throw new Error('PDF path required');

  const buffer = await readFile(path);

  const result = await extractStatement(
    buffer,
    new AbortController().signal,
  );

  console.log('Extraction Engine:', {
    status: result.status,
    pages: result.diagnostics.totalPages,
    transactions: result.rows.length,
    invalidRows: result.diagnostics.invalidRows,
    coverageComplete: result.diagnostics.coverage.complete,
    reconciled: result.diagnostics.reconciliation.reconciled,
  });

  assert.equal(result.status, 'candidate_pass');
  assert.equal(result.rows.length, 30);
  assert.equal(result.diagnostics.invalidRows, 0);

  console.log('Extraction coordinator test passed.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
