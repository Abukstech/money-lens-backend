import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from table_output import html_cells, unmapped_numeric_tokens, uncovered_amounts


class TableOutputTests(unittest.TestCase):
    def test_decodes_cells_and_wrapped_narration_without_rendering_html(self):
        self.assertEqual(html_cells('<table><tr><th>Date</th><th>Details</th></tr><tr><td>01/10/2026</td><td>Airtel<br/>recharge &amp; data</td></tr></table>'),
            [['Date', 'Details'], ['01/10/2026', 'Airtel recharge & data']])

    def test_expands_merged_header_cells_and_rowspan(self):
        self.assertEqual(html_cells('<table><tr><th rowspan="2">Date</th><th colspan="2">Money</th></tr><tr><th>Debit</th><th>Credit</th></tr></table>'),
            [['Date', 'Money', ''], ['Date', 'Debit', 'Credit']])

    def test_rejects_unbounded_or_broken_structures(self):
        for value in ['<table><tr><td colspan="100000">bad</td></tr></table>', '<table><tr><td>unfinished', '<table><tr><td rowspan="3">unfinished</td></tr></table>']:
            with self.assertRaises(ValueError): html_cells(value)

    def test_detects_lost_or_repeated_source_numbers(self):
        self.assertEqual(unmapped_numeric_tokens(['100.00', '100.00'], [['100.00']]), 1)
        self.assertEqual(unmapped_numeric_tokens(['100.00'], [['100.00', '100.00']]), 1)
        self.assertEqual(unmapped_numeric_tokens(['1,000.00', '01/10/2026'], [['1000.00', '01/10/2026']]), 0)

    def test_flags_financial_text_outside_tables_but_allows_summary_and_account_numbers(self):
        self.assertEqual(uncovered_amounts(['Account', '1234567890', 'Payment', '100.00'], set()), 1)
        self.assertEqual(uncovered_amounts(['Opening balance', '100.00'], set()), 0)
        self.assertEqual(uncovered_amounts(['Payment', '100.00'], {1}), 0)

if __name__ == '__main__': unittest.main()
