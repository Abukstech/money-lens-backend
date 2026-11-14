import DecimalJs from 'decimal.js';
// Keep kobo exact when aggregates exceed a single DECIMAL(20,2) row.
const Decimal = DecimalJs.clone({ precision: 40, rounding: DecimalJs.ROUND_HALF_UP });
type Decimal = DecimalJs;
import { BadRequestException } from '@nestjs/common';
import { expenseCategories } from './facts';
import { Metric, MonthlyFacts, Scenario, scenarioInput } from './contracts';

export function simulateCategoryCut(facts: MonthlyFacts, raw: unknown, id: string): Scenario {
  const parsed = scenarioInput.safeParse(raw);
  if (!parsed.success || !expenseCategories.includes(parsed.data.category))
    throw new BadRequestException('INVALID_SCENARIO');
  const input = parsed.data;
  const current = new Decimal(facts.metrics[`expenses.${input.category}`].value);
  let reduction: Decimal;
  if (input.reductionPercent !== null) {
    const percent = new Decimal(input.reductionPercent);
    if (percent.gt(100)) throw new BadRequestException('INVALID_SCENARIO');
    reduction = current.times(percent).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  } else reduction = new Decimal(input.reductionAmount!);
  if (reduction.gt(current) || reduction.lt(0)) throw new BadRequestException('INVALID_SCENARIO');
  const metrics: Record<string, Metric> = {};
  const put = (name: string, value: Decimal, label: string) => {
    metrics[`scenarios.${id}.${name}`] = { value: value.toFixed(2), kind: 'money', label };
  };
  put('reduction', reduction, 'Hypothetical amount freed, not money actually saved');
  put('new_category_total', current.minus(reduction), 'Hypothetical category spending');
  if (facts.metrics.remaining_after_known_allocations) {
    const room = new Decimal(facts.metrics.remaining_after_known_allocations.value).plus(reduction);
    put(
      'remaining_after_known_allocations',
      room,
      'Hypothetical room after known allocations, with all other amounts unchanged',
    );
    if (facts.metrics.remaining_savings_target) {
      const remaining = new Decimal(facts.metrics.remaining_savings_target.value);
      put(
        'remaining_funding_gap',
        remaining.eq(0) ? new Decimal(0) : Decimal.max(remaining.minus(room), 0),
        'Hypothetical remaining savings funding gap',
      );
    }
  }
  return {
    id,
    category: input.category,
    metrics,
    assumptions: [
      'All other income and spending remain unchanged.',
      'The category reduction is achievable only if those costs are flexible; do not skip essential bills or debt obligations.',
      'Money freed is not automatically saved; unrecorded costs may use it.',
    ],
  };
}
