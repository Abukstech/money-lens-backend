
import type {
    ExtractedPdfPage,
    PdfTextItem,
  } from './pdf-reader';
  
  export interface LayoutLine {
    page: number;
    y: number;
    items: PdfTextItem[];
    text: string;
  }
  
  export function detectLines(
    pages: ExtractedPdfPage[],
    tolerance = 3,
  ): LayoutLine[] {
    const result: LayoutLine[] = [];
  
    for (const page of pages) {
      const sorted = [...page.items].sort(
        (a, b) => b.y - a.y || a.x - b.x,
      );
  
      const lines: LayoutLine[] = [];
  
      for (const item of sorted) {
        const current = lines[lines.length - 1];
  
        if (!current || Math.abs(current.y - item.y) > tolerance) {
          lines.push({
            page: page.page,
            y: item.y,
            items: [item],
            text: '',
          });
        } else {
          current.items.push(item);
        }
      }
  
      for (const line of lines) {
        line.items.sort((a, b) => a.x - b.x);
  
        line.text = line.items
          .map((item) => item.text)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
  
        result.push(line);
      }
    }
  
    return result;
  }
  