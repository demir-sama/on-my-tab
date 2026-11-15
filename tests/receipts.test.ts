import { describe, expect, it } from "vitest";
import { receiptsFor, liveReceiptCount } from "@/lib/receipts";
import type { TabResult } from "@/lib/engine";

const line = (sku: string, total: number, verdict: "PAID" | "HOLD" | "REFUSED") =>
  ({ sku, title: sku, shopName: "x", qty: 1, unitPrice: total, total, reference: total, markup: 1, verdict, guard: "", spentAfter: 0 }) as unknown as TabResult["lines"][number];

describe("receipts", () => {
  it("links recorded Arc testnet txs and labels the demo buyer, never Passport", () => {
    const r = receiptsFor({ cap: 40, spent: 0, left: 40, lines: [line("pothos-ceramic", 16, "PAID")] });
    expect(r[0]!.mode).toBe("testnet");
    expect(r[0]!.url).toMatch(/^https:\/\/explorer\.testnet\.arc\.io\/tx\/0x[0-9a-f]{64}$/);
    expect(r[0]!.network).toBe("Arc testnet");
    expect(r[0]!.payerLabel).toBe("demo buyer wallet (Arc testnet), not Passport");
  });
  it("falls back to SEEDED when the amount differs or no tx exists; refused lines get none", () => {
    const r = receiptsFor({ cap: 60, spent: 0, left: 60, lines: [line("pothos-ceramic", 17, "PAID"), line("suya-platter", 18, "PAID"), line("show-ticket-resale", 76, "REFUSED")] });
    expect(r.map((x) => x.mode)).toEqual(["seeded", "seeded"]);
    expect(r[0]!.ref).toMatch(/^SEEDED-[0-9A-F]{8}$/);
  });
  it("counts the recorded gift run", () => expect(liveReceiptCount()).toBe(5));
});
