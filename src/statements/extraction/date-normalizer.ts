
export type DateOrder = 'DMY' | 'MDY';

const months: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4,
  may: 5, jun: 6, jul: 7, aug: 8,
  sep: 9, oct: 10, nov: 11, dec: 12,
};

function validDate(
  year: number,
  month: number,
  day: number,
): string | null {
  const value = new Date(Date.UTC(year, month - 1, day));

  if (
    value.getUTCFullYear() !== year ||
    value.getUTCMonth() + 1 !== month ||
    value.getUTCDate() !== day
  ) {
    return null;
  }

  return [
    String(year).padStart(4, '0'),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0'),
  ].join('-');
}


export function normalizeStatementDate(
  input: string,
  order?: DateOrder,
): string | null {
  let value = input
    .trim()
    .replace(/\s*([/:\-])\s*/g, '$1')
    .replace(/\s+/g, ' ');

  // Handle timestamps such as:
  // 12-11-2026 11:59:59 PM
  // 12/11/2026 14:30:00
  // 2026-11-12T14:30:00
  // 12 Nov 2026 09:15 AM
  const timestamp =
    /^(.*?)(?:[,\s]+|T)(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(
      value,
    );

  if (timestamp) {
    const hour = Number(timestamp[2]);
    const minute = Number(timestamp[3]);
    const second = Number(timestamp[4] ?? 0);
    const meridiem = timestamp[5]?.toLowerCase();

    const validHour = meridiem
      ? hour >= 1 && hour <= 12
      : hour >= 0 && hour <= 23;

    if (
      !validHour ||
      minute > 59 ||
      second > 59
    ) {
      return null;
    }

    // MoneyLens currently stores transaction dates.
    // We validate the time but return only the date.
    value = timestamp[1].trim();
  }

  // ISO: 2026-11-12
  const iso =
    /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);

  if (iso) {
    return validDate(
      Number(iso[1]),
      Number(iso[2]),
      Number(iso[3]),
    );
  }

  // Named months: 12 Nov 2026 / 12-Nov-2026
  const named =
    /^(\d{1,2})[\s/-]+([A-Za-z]{3,9})[\s,/-]+(\d{4})$/.exec(
      value,
    );

  if (named) {
    const month =
      months[named[2].slice(0, 3).toLowerCase()];

    if (!month) return null;

    return validDate(
      Number(named[3]),
      month,
      Number(named[1]),
    );
  }

  // Numeric: 12-11-2026 / 12/11/2026
  const numeric =
    /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(
      value,
    );

  if (!numeric) return null;

  const first = Number(numeric[1]);
  const second = Number(numeric[2]);
  const year = Number(numeric[3]);

  // Unambiguous day-month-year
  if (first > 12 && second <= 12) {
    return validDate(year, second, first);
  }

  // Unambiguous month-day-year
  if (second > 12 && first <= 12) {
    return validDate(year, first, second);
  }

  // Ambiguous numeric dates require confirmed order.
  if (!order) return null;

  return order === 'DMY'
    ? validDate(year, second, first)
    : validDate(year, first, second);
}
