
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { readPdf } from '../src/statements/extraction/pdf-reader';
import { detectLines } from '../src/statements/extraction/detector';
import { parseTableLines } from '../src/statements/extraction/table-parser';
import { verifyExtractionCoverage } from '../src/statements/extraction/coverage';

async function main() {
  const path = process.argv[2];

  if (!path) throw new Error('PDF path required');

  const buffer = await readFile(path);

  const pages = await readPdf(
    buffer,
    new AbortController().signal,
  );

  const lines = detectLines(pages);
  const parsed = parseTableLines(lines);

  // Test 1: Complete statement
  const complete = verifyExtractionCoverage(
    lines,
    parsed.rows,
    pages.length,
  );

  console.log('Complete statement:', complete);

  assert.equal(complete.totalCandidates, 30);
  assert.equal(complete.totalParsed, 30);
  assert.equal(complete.complete, true);

  // Test 2: First transaction missing from parser output
  const missingFirst = verifyExtractionCoverage(
    lines,
    parsed.rows.slice(1),
    pages.length,
  );

  assert.equal(missingFirst.complete, false);
  assert.ok(
    missingFirst.issues.some(
      issue => issue.code === 'TRANSACTION_COVERAGE_MISMATCH',
    ),
  );

  console.log('PASS: Missing first transaction detected');

  // Test 3: Last transaction missing
  const missingLast = verifyExtractionCoverage(
    lines,
    parsed.rows.slice(0, -1),
    pages.length,
  );

  assert.equal(missingLast.complete, false);

  console.log('PASS: Missing last transaction detected');

  // Test 4: Middle transaction missing
  const missingMiddle = verifyExtractionCoverage(
    lines,
    parsed.rows.filter((_, i) => i !== 10),
    pages.length,
  );

  assert.equal(missingMiddle.complete, false);

  console.log('PASS: Missing middle transaction detected');

  console.log('All coverage tests passed.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
