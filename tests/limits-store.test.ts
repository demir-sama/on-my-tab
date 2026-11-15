import { describe, expect, it } from "vitest";
import { clientIp, ipBucket, limitsFromEnv, visitorId } from "@/lib/limits";
import { memoryStore } from "@/lib/store";

const HOUR = 3_600_000;

describe("limitsFromEnv", () => {
  it("has strict defaults and reads overrides", () => {
    const d = limitsFromEnv({});
    expect(d.dailySettleAtomic).toBe(2_000_000n);
    expect(d.visitorRunsPerHour).toBe(3);
    expect(d.servDaily).toBe(40);
    expect(limitsFromEnv({ DAILY_SETTLE_CAP_USDC: "0.5", SERV_DAILY_LIMIT: "x" })).toMatchObject({ dailySettleAtomic: 500_000n, servDaily: 40 });
  });
  it("prefers Vercel's own IP header and hashes visitors", () => {
    const h = new Headers({ "x-forwarded-for": "6.6.6.6", "x-vercel-forwarded-for": "1.2.3.4, 9.9.9.9" });
    expect(clientIp(h)).toBe("1.2.3.4");
    expect(visitorId("1.2.3.4", "s")).toMatch(/^[0-9a-f]{24}$/);
    expect(visitorId("1.2.3.4", "s")).not.toBe(visitorId("1.2.3.5", "s"));
  });
  it("buckets IPv6 by /64 so rotating addresses count as one visitor", () => {
    expect(ipBucket("2a09:bac5:4dd7:188c::272:123")).toBe("2a09:bac5:4dd7:188c::/64");
    expect(ipBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipBucket("2001:0db8:0000:0042:1:2:3:4")).toBe("2001:db8:0:42::/64");
    expect(ipBucket("9.9.9.9")).toBe("9.9.9.9");
    expect(visitorId("2a09:bac5:4dd7:188c::1", "s")).toBe(visitorId("2a09:bac5:4dd7:188c::ffff:2", "s"));
  });
});

describe("memoryStore limits", () => {
  const L = { ...limitsFromEnv({}), dailySettleAtomic: 100n, dailySettleCount: 50, visitorRunsPerHour: 2, visitorLinesPerDay: 4, servDaily: 3, servVisitorPerHour: 2, servCacheTtlSec: 60 };

  it("enforces the daily test-USDC cap and frees failed rows", async () => {
    const s = memoryStore();
    const a = await s.reserve({ runId: "r1", sku: "a", visitor: "v1", amountAtomic: 60n }, L);
    expect(a.ok).toBe(true);
    expect(await s.reserve({ runId: "r2", sku: "a", visitor: "v2", amountAtomic: 50n }, L)).toEqual({ ok: false, reason: "daily_cap" });
    if (a.ok) await s.markFailed(a.id, "boom");
    expect((await s.reserve({ runId: "r2", sku: "a", visitor: "v2", amountAtomic: 50n }, L)).ok).toBe(true);
  });
  it("refuses duplicates but lets a failed line retry", async () => {
    const s = memoryStore();
    const a = await s.reserve({ runId: "r1", sku: "a", visitor: "v", amountAtomic: 1n }, L);
    expect(await s.reserve({ runId: "r1", sku: "a", visitor: "v", amountAtomic: 1n }, L)).toEqual({ ok: false, reason: "duplicate" });
    if (a.ok) await s.markFailed(a.id, "x");
    expect((await s.reserve({ runId: "r1", sku: "a", visitor: "v", amountAtomic: 1n }, L)).ok).toBe(true);
  });
  it("limits runs per visitor per hour and lines per day, with a rolling window", async () => {
    let t = 0;
    const s = memoryStore(() => t);
    expect((await s.reserve({ runId: "r1", sku: "a", visitor: "v", amountAtomic: 1n }, L)).ok).toBe(true);
    expect((await s.reserve({ runId: "r2", sku: "a", visitor: "v", amountAtomic: 1n }, L)).ok).toBe(true);
    expect(await s.reserve({ runId: "r3", sku: "a", visitor: "v", amountAtomic: 1n }, L)).toEqual({ ok: false, reason: "visitor_runs" });
    expect((await s.reserve({ runId: "r2", sku: "b", visitor: "v", amountAtomic: 1n }, L)).ok).toBe(true); // same run still fine
    expect((await s.reserve({ runId: "r9", sku: "a", visitor: "other", amountAtomic: 1n }, L)).ok).toBe(true);
    t += HOUR + 1;
    expect((await s.reserve({ runId: "r3", sku: "a", visitor: "v", amountAtomic: 1n }, L)).ok).toBe(true);
    expect(await s.reserve({ runId: "r3", sku: "b", visitor: "v", amountAtomic: 1n }, L)).toEqual({ ok: false, reason: "visitor_lines" });
    expect((await s.usage()).lines24h).toBe(5);
  });
  it("caps live SERV calls globally and per visitor", async () => {
    const s = memoryStore();
    expect(await s.takeServCall("v", L)).toBe(true);
    expect(await s.takeServCall("v", L)).toBe(true);
    expect(await s.takeServCall("v", L)).toBe(false);
    expect(await s.takeServCall("w", L)).toBe(true);
    expect(await s.takeServCall("x", L)).toBe(false);
  });
  it("expires cached plans after the TTL", async () => {
    let t = 0;
    const s = memoryStore(() => t);
    await s.putPlan("k", { plan: { picks: [] } as never, meta: { model: "m", latencyMs: 1 } as never });
    expect((await s.getPlan("k", 60))?.at).toBe(new Date(0).toISOString());
    t = 61_000;
    expect(await s.getPlan("k", 60)).toBeNull();
  });
});
