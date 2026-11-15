import { describe, expect, it } from "vitest";
import type { FacilitatorClient } from "@x402/core/server";
import { createSellerApp, parseQty } from "@/lib/seller";
import { decodeChallenge, preflight } from "@/lib/quotes";
import { ARC_TESTNET, KITE_TESTNET, toAtomic, fromAtomic } from "@/lib/kite";

const PAY_TO = "0x1234567890123456789012345678901234567890";
const supported = { kinds: [{ x402Version: 2, scheme: "exact", network: KITE_TESTNET.network }], extensions: [], signers: {} };

function harness(opts: { valid?: boolean; offline?: boolean } = {}) {
  const events: string[] = [];
  const facilitator: FacilitatorClient = {
    getSupported: async () => {
      if (opts.offline) throw new Error("offline");
      return supported as never;
    },
    verify: async () => {
      events.push("verify");
      return opts.valid === false ? { isValid: false, invalidReason: "invalid_signature" } : ({ isValid: true, payer: PAY_TO } as never);
    },
    settle: async () => {
      events.push("settle");
      return { success: true, transaction: "0xmock-not-on-chain", network: KITE_TESTNET.network, payer: PAY_TO } as never;
    },
  };
  return { app: createSellerApp({ payTo: PAY_TO, facilitator, arcFacilitator: null }), events };
}

describe("demo seller x402 endpoints", () => {
  it("unpaid buy returns a v2 exact 402 on Kite testnet with the item price", async () => {
    const { app, events } = harness();
    const res = await app.request("/api/shops/kiosk-nine/v1/buy/pothos-ceramic");
    expect(res.status).toBe(402);
    const ch = decodeChallenge(res.headers.get("payment-required"))!;
    expect(ch.x402Version).toBe(2);
    expect(ch.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "eip155:2368",
      asset: KITE_TESTNET.asset,
      payTo: PAY_TO,
      amount: toAtomic(16),
    });
    const body = await res.json();
    expect(body).toMatchObject({ demoSeller: true, sku: "pothos-ceramic", totalUsd: 16 });
    expect(events).toEqual([]);
  });

  it("qty multiplies the demanded amount", async () => {
    const { app } = harness();
    const res = await app.request("/api/shops/gate-resale/v1/buy/show-ticket-resale?qty=2");
    const ch = decodeChallenge(res.headers.get("payment-required"))!;
    expect(ch.accepts[0]!.amount).toBe(toAtomic(76));
  });

  it("rejects unknown items, mismatched shops and bad qty before any payment logic", async () => {
    const { app, events } = harness();
    expect((await app.request("/api/shops/kiosk-nine/v1/buy/nope")).status).toBe(404);
    expect((await app.request("/api/shops/gate-resale/v1/buy/pothos-ceramic")).status).toBe(404);
    expect((await app.request("/api/shops/kiosk-nine/v1/buy/pothos-ceramic?qty=99")).status).toBe(400);
    expect(events).toEqual([]);
  });

  it("fails closed when the facilitator is unreachable or payTo missing", async () => {
    const { app } = harness({ offline: true });
    expect((await app.request("/api/shops/kiosk-nine/v1/buy/pothos-ceramic")).status).toBe(503);
    const noPay = createSellerApp({ payTo: "", facilitator: { getSupported: async () => supported } as never });
    expect((await noPay.request("/api/shops/kiosk-nine/v1/buy/pothos-ceramic")).status).toBe(503);
  });

  it("garbage payment header never settles", async () => {
    const { app, events } = harness();
    const res = await app.request("/api/shops/kiosk-nine/v1/buy/pothos-ceramic", { headers: { "payment-signature": "not-base64" } });
    expect(res.status).toBe(402);
    expect(events).not.toContain("settle");
  });

  it("catalog and discovery are free and labelled demo", async () => {
    const { app } = harness();
    const cat = await (await app.request("/api/shops")).json();
    expect(cat.demo).toBe(true);
    const wk = await (await app.request("/api/shops/.well-known/x402")).json();
    expect(wk).toMatchObject({ x402Version: 2, scheme: "exact", network: "eip155:2368" });
  });

  it("preflight reads prices from the live 402 challenge, not the catalog", async () => {
    const { app } = harness();
    const q = await preflight(["show-ticket-official", "suya-platter"], { "show-ticket-official": 2 }, app);
    expect(q[0]).toMatchObject({ source: "x402", total: 28, unitPrice: 14, qty: 2, network: "eip155:2368" });
    expect(q[1]).toMatchObject({ source: "x402", total: 18 });
  });

  it("preflight falls back to catalog price (flagged) when the seller is down", async () => {
    const { app } = harness({ offline: true });
    const q = await preflight(["suya-platter"], {}, app);
    expect(q[0]).toMatchObject({ source: "catalog", total: 18 });
  });

  it("with the Arc rail on, the 402 offers Kite pieUSD and Arc USDC (6 dp) side by side", async () => {
    const arcSupported = { kinds: [{ x402Version: 2, scheme: "exact", network: ARC_TESTNET.network }], extensions: [], signers: {} };
    const app = createSellerApp({
      payTo: PAY_TO,
      facilitator: { getSupported: async () => supported } as never,
      arcFacilitator: { getSupported: async () => arcSupported } as never,
    });
    const res = await app.request("/api/shops/kiosk-nine/v1/buy/pothos-ceramic");
    expect(res.status).toBe(402);
    const ch = decodeChallenge(res.headers.get("payment-required"))!;
    expect(ch.accepts.map((a) => a.network)).toEqual(["eip155:2368", "eip155:5042002"]);
    expect(ch.accepts[1]).toMatchObject({ asset: ARC_TESTNET.asset, amount: "160000" });
  });

  it("amount math is exact", () => {
    expect(toAtomic(16, 0.01)).toBe("160000000000000000");
    expect(toAtomic(9.5, 1)).toBe("9500000000000000000");
    expect(fromAtomic(toAtomic(37.25, 0.01))).toBeCloseTo(0.3725);
    expect(toAtomic(16, 0.01, 6)).toBe("160000");
    expect(fromAtomic("160000", 6)).toBeCloseTo(0.16);
    expect(() => parseQty("0")).toThrow();
    expect(parseQty(undefined)).toBe(1);
  });
});
