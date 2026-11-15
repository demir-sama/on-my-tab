import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settleOnArc = vi.fn();
vi.mock("@/lib/settle", () => ({
  liveSettleEnabled: () => process.env.LIVE_SETTLE === "on",
  buyerAddress: () => null,
  settleOnArc: (...a: unknown[]) => settleOnArc(...a),
}));

import { POST } from "@/app/api/settle/route";
import { issueRunToken } from "@/lib/run-token";
import { clientIp, visitorId } from "@/lib/limits";
import { memoryStore, setStore } from "@/lib/store";
import type { TabResult } from "@/lib/engine";

const TX = `0x${"cd".repeat(32)}`;
const line = (sku: string, total: number, verdict: string) =>
  ({ sku, title: sku, shopName: "x", qty: 1, unitPrice: total, total, reference: total, markup: 1, verdict, guard: "", spentAfter: 0 }) as unknown as TabResult["lines"][number];
const result = { cap: 40, spent: 16, left: 24, lines: [line("pothos-ceramic", 16, "PAID"), line("suya-platter", 18, "HOLD"), line("show-ticket-resale", 76, "REFUSED")] } as unknown as TabResult;

const IP = "1.2.3.4";
const req = (body: unknown, ip = IP) =>
  new Request("http://x/api/settle", { method: "POST", headers: { "content-type": "application/json", "x-vercel-forwarded-for": ip }, body: JSON.stringify(body) });
const tokenFor = (ip = IP) => issueRunToken(result, visitorId(clientIp(new Headers({ "x-vercel-forwarded-for": ip })))).token;

describe("POST /api/settle", () => {
  beforeEach(() => {
    Object.assign(process.env, { LIVE_SETTLE: "on", SETTLE_SCALE: "0.001", DAILY_SETTLE_CAP_USDC: "2" });
    setStore(memoryStore());
    settleOnArc.mockReset().mockResolvedValue({ tx: TX, network: "eip155:5042002", payer: "0x", amountAtomic: "16000" });
  });
  afterEach(() => setStore(undefined));

  it("settles a PAID line live at the configured scale, exactly once", async () => {
    const token = tokenFor();
    const r = await (await POST(req({ token, sku: "pothos-ceramic" }))).json();
    expect(r.receipt).toMatchObject({ mode: "live", displayUsd: 16, onchain: "0.016", ref: TX });
    expect(settleOnArc).toHaveBeenCalledWith(expect.stringContaining("/v1/buy/pothos-ceramic"), "16000");
    const res = await POST(req({ token, sku: "pothos-ceramic" }));
    expect(res.status).toBe(409);
    const again = await res.json();
    expect(again.receipt.mode).toBe("none");
    expect(again.receipt.note).toMatch(/already settled/);
    expect(settleOnArc).toHaveBeenCalledTimes(1);
  });
  it("only pays a HOLD after a raise and never pays refused lines", async () => {
    const token = tokenFor();
    expect((await POST(req({ token, sku: "suya-platter" }))).status).toBe(400);
    expect((await POST(req({ token, sku: "show-ticket-resale", raised: true }))).status).toBe(400);
    expect((await (await POST(req({ token, sku: "suya-platter", raised: true }))).json()).receipt.mode).toBe("live");
  });
  it("rejects a token from another visitor or a forged one", async () => {
    expect((await POST(req({ token: tokenFor("5.5.5.5"), sku: "pothos-ceramic" }))).status).toBe(403);
    expect((await POST(req({ token: "aaaaaaaaaa.bbbb", sku: "pothos-ceramic" }))).status).toBe(403);
    expect(settleOnArc).not.toHaveBeenCalled();
  });
  it("falls back to a labelled recorded settlement when the daily cap is hit", async () => {
    process.env.DAILY_SETTLE_CAP_USDC = "0.01";
    const r = await (await POST(req({ token: tokenFor(), sku: "pothos-ceramic" }))).json();
    expect(r.receipt).toMatchObject({ mode: "recorded", onchain: "0.16" });
    expect(r.receipt.note).toMatch(/budget is used up/);
    expect(settleOnArc).not.toHaveBeenCalled();
  });
  it("falls back when settlement fails or live settle is off", async () => {
    settleOnArc.mockRejectedValueOnce(new Error("rpc down"));
    const r = await (await POST(req({ token: tokenFor(), sku: "pothos-ceramic" }))).json();
    expect(r.receipt.mode).toBe("recorded");
    expect(r.receipt.note).toMatch(/didn't go through/);
    process.env.LIVE_SETTLE = "off";
    const off = await (await POST(req({ token: tokenFor(), sku: "pothos-ceramic" }))).json();
    expect(off.receipt.note).toMatch(/switched off/);
  });
});
