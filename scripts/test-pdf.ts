
import { readFile } from 'node:fs/promises';
import { readPdf } from '../src/statements/extraction/pdf-reader';

async function main() {
  const filePath = process.argv[2];

  if (!filePath) {
    throw new Error(
      'Usage: npx tsx scripts/test-pdf.ts <pdf-path>',
    );
  }

  const buffer = await readFile(filePath);
  const controller = new AbortController();

  const pages = await readPdf(buffer, controller.signal);

  console.log('PDF Analysis:', {
    totalPages: pages.length,
    pagesWithText: pages.filter((p) => p.hasText).length,
    totalTextItems: pages.reduce(
      (sum, p) => sum + p.items.length,
      0,
    ),
  });

  for (const page of pages) {
    console.log(`Page ${page.page + 1}:`, {
      textItems: page.items.length,
      width: page.width,
      height: page.height,
      hasText: page.hasText,
    });
  }
}

main().catch((error) => {
  console.error('PDF test failed:', error);
  process.exitCode = 1;
});
