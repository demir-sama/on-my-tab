import { describe, expect, it } from "vitest";
import { BRIEFS, productBySku, SHOPS } from "@/lib/catalog";
import { enforce, fallbackPlan, isBadDeal, normalisePlan, resolveHold, type Plan, type Quote } from "@/lib/engine";

function quotesFor(briefId: string): Quote[] {
  const b = BRIEFS.find((x) => x.id === briefId)!;
  return b.candidates.map((sku) => {
    const p = productBySku(sku)!;
    const qty = b.qty?.[sku] ?? 1;
    return {
      sku, shop: p.shop, shopName: SHOPS[p.shop].name, title: p.title, group: p.group, extra: Boolean(p.extra),
      unitPrice: p.price, qty, total: p.price * qty, reference: p.reference, source: "catalog", endpoint: "/x",
    };
  });
}

describe("tab engine", () => {
  it("gift brief: pays core items, refuses the 2.7× journal, holds the courier over the cap", () => {
    const q = quotesFor("gift");
    const r = enforce(fallbackPlan("gift", q, 40), q, 40);
    const v = Object.fromEntries(r.lines.map((l) => [l.sku, l.verdict]));
    expect(v).toMatchObject({
      "pothos-ceramic": "PAID", "linen-journal": "PAID", "card-wrap": "PAID", "pressed-bookmark": "PAID",
      "linen-journal-gilded": "REFUSED", "same-day-courier": "HOLD",
    });
    expect(r.spent).toBe(37);
    expect(r.left).toBe(3);
    expect(r.lines.find((l) => l.sku === "same-day-courier")!.overBy).toBe(6.5);
  });

  it("night brief: refuses the scalper at 2.7× face, holds VIP", () => {
    const q = quotesFor("night");
    const r = enforce(fallbackPlan("night", q, 60), q, 60);
    const resale = r.lines.find((l) => l.sku === "show-ticket-resale")!;
    expect(resale.verdict).toBe("REFUSED");
    expect(resale.markup).toBe(2.7);
    expect(r.lines.find((l) => l.sku === "vip-lounge")!.verdict).toBe("HOLD");
    expect(r.spent).toBe(57);
  });

  it("never exceeds the cap whatever the plan says", () => {
    const q = quotesFor("night");
    for (const cap of [1, 5, 13.99, 28, 45.5, 60, 100]) {
      const plan: Plan = { summary: "", note: "", steps: q.map((x) => ({ sku: x.sku, decision: "buy", reason: "" })) };
      const r = enforce(plan, q, cap);
      expect(r.spent).toBeLessThanOrEqual(cap);
      expect(r.lines.filter((l) => l.verdict === "PAID").reduce((s, l) => s + l.total, 0)).toBeCloseTo(r.spent);
    }
  });

  it("a model cannot force a gouged buy", () => {
    const q = quotesFor("gift");
    const plan: Plan = { summary: "", note: "", steps: [{ sku: "linen-journal-gilded", decision: "buy", reason: "trust me" }] };
    const line = enforce(plan, q, 500).lines.find((l) => l.sku === "linen-journal-gilded")!;
    expect(line.verdict).toBe("REFUSED");
    expect(line.servDecision).toBe("buy");
  });

  it("drops unknown or duplicate SKUs from a hostile plan", () => {
    const q = quotesFor("gift");
    const steps = normalisePlan(
      { summary: "", note: "", steps: [{ sku: "evil", decision: "buy", reason: "" }, { sku: "card-wrap", decision: "buy", reason: "a" }, { sku: "card-wrap", decision: "skip", reason: "b" }] } as Plan,
      q,
    );
    expect(steps).toEqual([{ sku: "card-wrap", decision: "buy", reason: "a" }]);
  });

  it("buys only one of substitutable items", () => {
    const q = quotesFor("night");
    const r = enforce(fallbackPlan("n", q, 500), q, 500);
    expect(r.lines.filter((l) => l.verdict === "PAID" && l.sku.startsWith("show-ticket"))).toHaveLength(1);
  });

  it("resolving a hold: raise pays exactly the overage, skip leaves the tab alone", () => {
    const q = quotesFor("gift");
    const r = enforce(fallbackPlan("g", q, 40), q, 40);
    const raised = resolveHold(r, "same-day-courier", "raise");
    expect(raised.cap).toBe(46.5);
    expect(raised.spent).toBe(46.5);
    expect(raised.left).toBe(0);
    const skipped = resolveHold(r, "same-day-courier", "skip");
    expect(skipped.spent).toBe(37);
    expect(skipped.lines.find((l) => l.sku === "same-day-courier")!.verdict).toBe("SKIPPED");
    expect(() => resolveHold(r, "pothos-ceramic", "raise")).toThrow();
  });

  it("bad-deal line is 1.5× the fair anchor", () => {
    const q = quotesFor("gift");
    const j = q.find((x) => x.sku === "linen-journal")!;
    expect(isBadDeal({ ...j, sku: "t", unitPrice: 18 }, q)).toBe(false);
    expect(isBadDeal({ ...j, sku: "t", unitPrice: 18.01 }, q)).toBe(true);
  });

  it("rejects a non-positive cap", () => {
    expect(() => enforce({ summary: "", note: "", steps: [] }, [], 0)).toThrow();
  });
});
