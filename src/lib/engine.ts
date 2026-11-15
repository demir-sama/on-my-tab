// The tab engine. SERV proposes; this code disposes.
// Cap and bad-deal rules are enforced deterministically here, so a model can
// never spend past the sealed tab or buy a gouged item, whatever it says.

export const BAD_DEAL_RATIO = 1.5;

export interface Quote {
  sku: string;
  shop: string;
  shopName: string;
  title: string;
  group: string;
  extra: boolean;
  unitPrice: number;
  qty: number;
  total: number;
  reference: number;
  /** "x402" when read from a live 402 Payment-Required challenge. */
  source: "x402" | "catalog";
  network?: string;
  asset?: string;
  amountAtomic?: string;
  payTo?: string;
  endpoint: string;
}

export interface PlanStep {
  sku: string;
  decision: "buy" | "skip";
  reason: string;
}

export interface Plan {
  summary: string;
  steps: PlanStep[];
  note: string;
}

export type Verdict = "PAID" | "HOLD" | "REFUSED" | "SKIPPED";

export interface Line {
  sku: string;
  verdict: Verdict;
  title: string;
  shopName: string;
  qty: number;
  unitPrice: number;
  total: number;
  reference: number;
  /** unit price ÷ fair anchor, rounded to 0.1 */
  markup: number;
  servDecision: "buy" | "skip" | "not-planned";
  servReason: string;
  guard: string;
  overBy?: number;
  /** Tab spent after this line resolves. */
  spentAfter: number;
}

export interface TabResult {
  cap: number;
  spent: number;
  left: number;
  lines: Line[];
}

export const cents = (n: number) => Math.round(n * 100) / 100;
export const money = (n: number) => `$${cents(n).toFixed(2)}`;

/** Fair anchor = the lower of the reference rate and the cheapest substitute on offer. */
export function fairAnchor(q: Quote, all: Quote[]): number {
  const subs = all.filter((o) => o.group === q.group && o.sku !== q.sku).map((o) => o.unitPrice);
  return Math.min(q.reference, ...subs);
}

export function markupOf(q: Quote, all: Quote[]): number {
  const anchor = fairAnchor(q, all);
  return anchor > 0 ? Math.round((q.unitPrice / anchor) * 10) / 10 : 1;
}

export function isBadDeal(q: Quote, all: Quote[]): boolean {
  return q.unitPrice > fairAnchor(q, all) * BAD_DEAL_RATIO + 1e-9;
}

/** Normalise a (possibly hostile or sloppy) model plan against the quotes we actually hold. */
export function normalisePlan(plan: Plan, quotes: Quote[]): PlanStep[] {
  const known = new Set(quotes.map((q) => q.sku));
  const seen = new Set<string>();
  const steps: PlanStep[] = [];
  for (const s of plan.steps ?? []) {
    if (!s || typeof s.sku !== "string" || !known.has(s.sku) || seen.has(s.sku)) continue;
    seen.add(s.sku);
    steps.push({
      sku: s.sku,
      decision: s.decision === "skip" ? "skip" : "buy",
      reason: String(s.reason ?? "").slice(0, 280),
    });
  }
  return steps;
}

export function enforce(plan: Plan, quotes: Quote[], cap: number): TabResult {
  if (!Number.isFinite(cap) || cap <= 0) throw new Error("cap must be a positive number");
  const steps = normalisePlan(plan, quotes);
  const planned = new Set(steps.map((s) => s.sku));
  const ordered: { q: Quote; step: PlanStep | null }[] = [
    ...steps.map((s) => ({ q: quotes.find((q) => q.sku === s.sku)!, step: s })),
    ...quotes.filter((q) => !planned.has(q.sku)).map((q) => ({ q, step: null })),
  ];
  let spent = 0;
  const groupsBought = new Set<string>();
  const lines: Line[] = [];
  for (const { q, step } of ordered) {
    const base = {
      sku: q.sku,
      title: q.title,
      shopName: q.shopName,
      qty: q.qty,
      unitPrice: q.unitPrice,
      total: cents(q.total),
      reference: q.reference,
      markup: markupOf(q, quotes),
      servDecision: step ? step.decision : ("not-planned" as const),
      servReason: step?.reason ?? "",
    };
    if (isBadDeal(q, quotes)) {
      lines.push({
        ...base,
        verdict: "REFUSED",
        guard: `${base.markup}× the going rate (${money(fairAnchor(q, quotes))}). Over the ${BAD_DEAL_RATIO}× bad-deal line.`,
        spentAfter: cents(spent),
      });
      continue;
    }
    if (!step || step.decision === "skip") {
      lines.push({ ...base, verdict: "SKIPPED", guard: step ? "SERV left it out." : "Not in SERV's plan.", spentAfter: cents(spent) });
      continue;
    }
    if (groupsBought.has(q.group)) {
      lines.push({ ...base, verdict: "SKIPPED", guard: "Already have one of these.", spentAfter: cents(spent) });
      continue;
    }
    if (cents(spent + q.total) > cap + 1e-9) {
      const overBy = cents(spent + q.total - cap);
      lines.push({
        ...base,
        verdict: "HOLD",
        guard: `Would put the tab ${money(overBy)} over. Asking you first.`,
        overBy,
        spentAfter: cents(spent),
      });
      continue;
    }
    spent = cents(spent + q.total);
    groupsBought.add(q.group);
    lines.push({ ...base, verdict: "PAID", guard: "Fits the tab and the going rate.", spentAfter: spent });
  }
  return { cap, spent: cents(spent), left: cents(cap - spent), lines };
}

/** The user answers a HOLD: raise the tab just enough for this item, or skip it. */
export function resolveHold(result: TabResult, sku: string, action: "raise" | "skip"): TabResult {
  const idx = result.lines.findIndex((l) => l.sku === sku && l.verdict === "HOLD");
  if (idx < 0) throw new Error("no hold for that item");
  const line = result.lines[idx]!;
  const lines = result.lines.slice();
  if (action === "skip") {
    lines[idx] = { ...line, verdict: "SKIPPED", guard: "You said skip it.", overBy: undefined };
    return { ...result, lines };
  }
  const spent = cents(result.spent + line.total);
  const cap = Math.max(result.cap, spent);
  lines[idx] = { ...line, verdict: "PAID", guard: `You raised the tab by ${money(cap - result.cap)}.`, overBy: undefined, spentAfter: spent };
  return { cap, spent, left: cents(cap - spent), lines };
}

/** Deterministic planner used when SERV is not configured or fails. Flagged in the UI. */
export function fallbackPlan(want: string, quotes: Quote[], cap: number): Plan {
  const steps: PlanStep[] = quotes.map((q) => {
    const bad = isBadDeal(q, quotes);
    return {
      sku: q.sku,
      decision: bad ? "skip" : "buy",
      reason: bad
        ? `Same thing is ${money(fairAnchor(q, quotes))} elsewhere.`
        : q.extra
          ? "Nice extra if the tab allows."
          : "Core to the brief at a fair price.",
    };
  });
  // Core items first, extras last: keep the brief whole before nice-to-haves.
  steps.sort((a, b) => Number(quotes.find((q) => q.sku === a.sku)!.extra) - Number(quotes.find((q) => q.sku === b.sku)!.extra));
  return {
    summary: `Rule-based plan for "${want.slice(0, 80)}" under ${money(cap)}.`,
    steps,
    note: "",
  };
}
