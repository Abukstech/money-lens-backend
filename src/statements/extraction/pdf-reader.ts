import { getDocument, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';

export class InvalidStatementPdf extends Error {
  constructor(readonly code: 'INVALID_PDF' | 'PASSWORD_PROTECTED_PDF') {
    super(code);
  }
}

export interface PdfTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExtractedPdfPage {
  page: number;
  width: number;
  height: number;
  items: PdfTextItem[];
  hasText: boolean;
}

export async function readPdf(buffer: Buffer, signal: AbortSignal): Promise<ExtractedPdfPage[]> {
  signal.throwIfAborted();

  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    stopAtErrors: true,
    verbosity: VerbosityLevel.ERRORS,
  });
  let removeAbortListener: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', abort);
  });

  try {
    return await Promise.race([readPages(), cancelled]);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof InvalidStatementPdf) throw error;
    throw new InvalidStatementPdf(
      error instanceof Error && error.name === 'PasswordException'
        ? 'PASSWORD_PROTECTED_PDF'
        : 'INVALID_PDF',
    );
  } finally {
    removeAbortListener?.();
    await loadingTask.destroy();
  }

  async function readPages() {
    const pdf = await loadingTask.promise;
    signal.throwIfAborted();
    const { info } = await pdf.getMetadata();
    if ((info as { EncryptFilterName?: unknown }).EncryptFilterName) {
      throw new InvalidStatementPdf('PASSWORD_PROTECTED_PDF');
    }
    if (pdf.numPages < 1) throw new InvalidStatementPdf('INVALID_PDF');
    const pages: ExtractedPdfPage[] = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      signal.throwIfAborted();

      const page = await pdf.getPage(pageNumber);

      try {
        const viewport = page.getViewport({ scale: 1 });
        signal.throwIfAborted();
        const content = await page.getTextContent();

        const items: PdfTextItem[] = [];

        for (const item of content.items) {
          if (!('str' in item) || !item.str.trim()) {
            continue;
          }

          items.push({
            text: item.str,
            x: item.transform[4],
            y: item.transform[5],
            width: item.width,
            height: item.height,
          });
        }

        pages.push({
          page: pageNumber - 1,
          width: viewport.width,
          height: viewport.height,
          items,
          hasText: items.length > 0,
        });
      } finally {
        page.cleanup();
      }
    }

    return pages;
  }
}
