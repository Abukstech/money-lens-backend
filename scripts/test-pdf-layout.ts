
import { readFile } from 'node:fs/promises';
import { readPdf } from '../src/statements/extraction/pdf-reader';
import { detectLines } from '../src/statements/extraction/detector';

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error('Provide a PDF file path');

  const buffer = await readFile(path);
  const pages = await readPdf(
    buffer,
    new AbortController().signal,
  );

  const lines = detectLines(pages);

  // Fixture-specific verification only.
  // Production detection must not depend on TXN references.
  const references = lines.flatMap((line) =>
    [...line.text.matchAll(/\bTXN\d{5}\b/g)].map(
      (match) => ({
        reference: match[0],
        page: line.page + 1,
      }),
    ),
  );

  const found = new Set(references.map((r) => r.reference));

  const missing = Array.from({ length: 30 }, (_, i) =>
    `TXN${String(i + 1).padStart(5, '0')}`,
  ).filter((ref) => !found.has(ref));

  console.log('Layout Analysis:', {
    pages: pages.length,
    totalLines: lines.length,
    transactionReferences: references.length,
    uniqueReferences: found.size,
    page1: references.filter((r) => r.page === 1).length,
    page2: references.filter((r) => r.page === 2).length,
    missing,
  });

  if (missing.length || found.size !== 30) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
