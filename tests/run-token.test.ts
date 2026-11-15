import { describe, expect, it } from "vitest";
import { issueRunToken, payableLine, TOKEN_TTL_MS, verifyRunToken } from "@/lib/run-token";
import type { TabResult } from "@/lib/engine";

const KEY = "k".repeat(40);
const line = (sku: string, total: number, verdict: "PAID" | "HOLD" | "REFUSED" | "SKIPPED") =>
  ({ sku, title: sku, shopName: "x", qty: 1, unitPrice: total, total, reference: total, markup: 1, verdict, guard: "", spentAfter: 0 }) as unknown as TabResult["lines"][number];
const result = { cap: 40, spent: 16, left: 24, lines: [line("a", 16, "PAID"), line("b", 30, "HOLD"), line("c", 90, "REFUSED")] } as unknown as TabResult;

describe("run tokens", () => {
  const now = 1_000_000;
  const { token, runId } = issueRunToken(result, "visitor-1", now, KEY);

  it("round-trips and only carries PAID and HOLD lines", () => {
    const v = verifyRunToken(token, "visitor-1", now + 1000, KEY);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.run.runId).toBe(runId);
    expect(v.run.lines.map((l) => l.sku)).toEqual(["a", "b"]);
  });
  it("rejects tampering, a different key, other visitors, expiry and junk", () => {
    const [body, sig] = token.split(".") as [string, string];
    const forged = Buffer.from(Buffer.from(body, "base64url").toString().replace('"total":16', '"total":1')).toString("base64url");
    expect(verifyRunToken(`${forged}.${sig}`, "visitor-1", now, KEY)).toEqual({ ok: false, error: "bad_signature" });
    expect(verifyRunToken(token, "visitor-1", now, "z".repeat(40))).toEqual({ ok: false, error: "bad_signature" });
    expect(verifyRunToken(token, "visitor-2", now, KEY)).toEqual({ ok: false, error: "wrong_visitor" });
    expect(verifyRunToken(token, "visitor-1", now + TOKEN_TTL_MS + 1, KEY)).toEqual({ ok: false, error: "expired" });
    expect(verifyRunToken("nope", "visitor-1", now, KEY)).toEqual({ ok: false, error: "malformed" });
  });
  it("pays PAID lines, HOLD lines only when raised, never refused or unknown lines", () => {
    const v = verifyRunToken(token, "visitor-1", now, KEY);
    if (!v.ok) throw new Error("bad");
    expect(payableLine(v.run, "a", false)?.total).toBe(16);
    expect(payableLine(v.run, "b", false)).toBeNull();
    expect(payableLine(v.run, "b", true)?.total).toBe(30);
    expect(payableLine(v.run, "c", true)).toBeNull();
    expect(payableLine(v.run, "zzz", true)).toBeNull();
  });
});
