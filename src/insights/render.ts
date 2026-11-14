import Decimal from 'decimal.js';
import { Draft, draftSchema, Metric, MonthlyFacts, Scenario } from './contracts';
export class InvalidInsight extends Error {
  constructor() {
    super('INVALID_INSIGHT_OUTPUT');
  }
}
const placeholder = /\{\{([a-z][a-z0-9_.]*)\}\}/g;
export function formatMetric(metric: Metric) {
  const value = new Decimal(metric.value).toFixed(metric.kind === 'count' ? 0 : 2);
  const grouped = value.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return metric.kind === 'money'
    ? `₦${grouped}`
    : metric.kind === 'percent'
      ? `${value}%`
      : grouped;
}
export function renderReport(raw: unknown, facts: MonthlyFacts, scenarios: Scenario[]): Draft {
  const parsed = draftSchema.safeParse(raw);
  if (!parsed.success) throw new InvalidInsight();
  const metrics = {
    ...facts.metrics,
    ...Object.assign({}, ...scenarios.map((s) => s.metrics)),
  } as Record<string, Metric>;
  const text = (value: string, evidence?: string[]) => {
    const refs = [...value.matchAll(placeholder)].map((m) => m[1]);
    if (refs.some((id) => !metrics[id] || (evidence && !evidence.includes(id))))
      throw new InvalidInsight();
    const prose = value.replace(placeholder, '');
    if (
      /[{}\p{N}₦$%]/u.test(prose) ||
      /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion)\b/i.test(
        prose,
      ) ||
      /https?:|@|\b(?:account number|api key|password|registrationGrant)\s*[:=]/i.test(prose)
    )
      throw new InvalidInsight();
    if (
      /\b(irresponsible|reckless|lazy|impulsive|addict|social pressure|financial health score)\b/i.test(
        prose,
      )
    )
      throw new InvalidInsight();
    if (
      /\b(skip|miss|stop|ignore|delay|avoid|default)\b.{0,60}\b(rent|essential|bill|debt|repayment|medicine|insurance)\b/i.test(
        prose,
      )
    )
      throw new InvalidInsight();
    if (
      /\b(buy|sell|invest in)\b.{0,60}\b(stock|crypto|coin|fund|shares|security|securities)\b/i.test(
        prose,
      )
    )
      throw new InvalidInsight();
    if (
      /\b(?:you (?:have no savings|will never save|cannot save|can't save)|no savings at all)\b/i.test(
        prose,
      )
    )
      throw new InvalidInsight();
    if (
      facts.goalStatus === 'met' &&
      /\b(?:miss(?:ed)?|fail(?:ed)?|cannot meet|can't meet|won't meet|will not meet|short of|below)\b.{0,45}\b(?:saving|goal|target)/i.test(
        prose,
      )
    )
      throw new InvalidInsight();
    const spendingCriticism =
      /\b(?:overspending|too much|excessive spending|unsustainable|unaffordable)\b/i.test(prose);
    const constraintIds = ['savings_funding_gap', 'known_allocation_deficit'].filter(
      (id) => facts.metrics[id] && new Decimal(facts.metrics[id].value).gt(0),
    );
    if (
      spendingCriticism &&
      (!facts.coverage.complete || !refs.some((id) => constraintIds.includes(id)))
    )
      throw new InvalidInsight();
    if (
      !facts.coverage.complete &&
      /\b(?:you won't (?:save|meet)|you will not (?:save|meet))\b/i.test(prose)
    )
      throw new InvalidInsight();
    return value.replace(placeholder, (_match, id: string) => formatMetric(metrics[id]));
  };
  const checkEvidence = (ids: string[]) => {
    if (ids.some((id) => !metrics[id])) throw new InvalidInsight();
  };
  const report = parsed.data;
  return {
    narrative: text(report.narrative),
    findings: report.findings.map((f) => {
      checkEvidence(f.evidenceIds);
      return {
        ...f,
        observation: text(f.observation, f.evidenceIds),
        consequence: text(f.consequence, f.evidenceIds),
        suggestedAction: text(f.suggestedAction, f.evidenceIds),
        assumptions: f.assumptions.map((v) => text(v, f.evidenceIds)),
        missingContext: f.missingContext.map((v) => text(v, f.evidenceIds)),
      };
    }),
    actions: report.actions.map((a) => {
      checkEvidence(a.evidenceIds);
      const scenario = a.scenarioId ? scenarios.find((s) => s.id === a.scenarioId) : null;
      if (a.scenarioId && !scenario) throw new InvalidInsight();
      return {
        ...a,
        text: text(a.text, a.evidenceIds) + (scenario ? ` ${scenario.assumptions.join(' ')}` : ''),
      };
    }),
    limitations: report.limitations.map((v) => text(v)),
    questions: report.questions.map((v) => text(v)),
  };
}
// Questions never gain access to transaction narrations or recipient lookup. Redact common identifiers locally.
export function sanitizeQuestion(value: string) {
  return value
    .normalize('NFKC')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[PRIVATE EMAIL]')
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      '[PRIVATE IDENTIFIER]',
    )
    .replace(/(?:\+?\d[\s.-]*){10,}/g, '[PRIVATE NUMBER]')
    .replace(
      /\b(?:account\s*(?:holder|name)|recipient|beneficiary|my name)\s*(?:is|:|=)\s*[^,.;?!]+/gi,
      '[PRIVATE NAME]',
    )
    .replace(/\b(?:to|from|paid)\s+(?:[A-Z][a-z]+\s+){0,2}[A-Z][a-z]+\b/g, '[PRIVATE COUNTERPARTY]')
    .replace(/https?:\/\/\S+/gi, '[PRIVATE URL]')
    .trim()
    .slice(0, 2000);
}
