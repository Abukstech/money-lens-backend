"""Bounded conversion of model-produced HTML into plain table cells.

No bank layouts, transaction inference, HTML rendering, or document persistence.
"""
from collections import Counter
from html.parser import HTMLParser
import re
import unicodedata


class TableCells(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows = []
        self.current = None
        self.cell = None
        self.spans = {}
        self.rowspan = self.colspan = 1
        self.invalid = False

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            if self.current is not None:
                self.invalid = True
            self.current = []
        elif tag in ("td", "th"):
            if self.current is None or self.cell is not None:
                self.invalid = True
                return
            attributes = dict(attrs)
            try:
                self.rowspan = int(attributes.get("rowspan", "1"))
                self.colspan = int(attributes.get("colspan", "1"))
            except (ValueError, TypeError):
                self.invalid = True
                return
            if not 1 <= self.rowspan <= 100 or not 1 <= self.colspan <= 40:
                self.invalid = True
                return
            self.cell = []
        elif tag == "br" and self.cell is not None:
            self.cell.append(" ")

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)

    def _fill_spans(self):
        while len(self.current) in self.spans:
            index = len(self.current)
            remaining, text = self.spans[index]
            self.current.append(text)
            if remaining == 1:
                del self.spans[index]
            else:
                self.spans[index] = (remaining - 1, text)

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self.cell is not None and self.current is not None:
            self._fill_spans()
            text = re.sub(r"\s+", " ", "".join(self.cell)).strip()
            if len(text) > 4000:
                self.invalid = True
            for offset in range(self.colspan):
                index = len(self.current)
                if index in self.spans:
                    self.invalid = True
                self.current.append(text if offset == 0 else "")
                if self.rowspan > 1:
                    self.spans[index] = (self.rowspan - 1, text if offset == 0 else "")
            self.cell = None
        elif tag == "tr" and self.current is not None:
            self._fill_spans()
            if self.cell is not None or len(self.current) > 40 or len(self.rows) >= 2000:
                self.invalid = True
            self.rows.append(self.current)
            self.current = None


def html_cells(html):
    if not isinstance(html, str) or len(html) > 2_000_000:
        raise ValueError("INVALID_TABLE_STRUCTURE")
    parser = TableCells()
    parser.feed(html)
    parser.close()
    if parser.invalid or parser.current is not None or parser.cell is not None or parser.spans:
        raise ValueError("INVALID_TABLE_STRUCTURE")
    return parser.rows


def numeric_tokens(text):
    normalized = unicodedata.normalize("NFKC", text).replace(",", "")
    return Counter(re.findall(r"\d+(?:\.\d+)?", normalized))


def unmapped_numeric_tokens(texts, rows):
    """Compare independent OCR numbers with numbers placed into table cells.

    Model HTML is made from those OCR results, so missing numbers indicate lost
    content. Duplicate source numbers must each appear; a substring is not proof.
    """
    source = numeric_tokens(" ".join(texts))
    mapped = numeric_tokens(" ".join(cell for row in rows for cell in row))
    return sum((source - mapped).values()) + sum((mapped - source).values())


def uncovered_amounts(texts, covered):
    """Find monetary OCR boxes outside every detected table.

    Header/account numbers are not amounts. Explicit statement summaries may
    sit outside a transaction table; nearby summary labels identify those.
    """
    amount = re.compile(r"^(?:NGN\s*|₦\s*)?[+-]?\d[\d,]*\.\d{2}(?:\s*(?:DR|CR))?$", re.I)
    summary = re.compile(r"\b(?:opening balance|closing balance|total debits?|total credits?|total withdrawals?|total deposits?|brought forward|carried forward)\b", re.I)
    count = 0
    for index, text in enumerate(texts):
        if index in covered or not amount.fullmatch(text.strip()):
            continue
        context = re.sub(r"\s+", " ", " ".join(texts[max(0, index - 2):index + 2]))
        if not summary.search(context):
            count += 1
    return count
