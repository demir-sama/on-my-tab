// Demo seller endpoints: real x402 v2 "exact" challenges on Kite testnet,
// adapted from BrKDDD/kite-x402-hono (Hono + @x402/hono + Pieverse facilitator).
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { cors } from "hono/cors";
import { paymentMiddlewareFromHTTPServer, x402HTTPResourceServer, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { PRODUCTS, SHOPS, productBySku, type ShopId } from "./catalog";
import { ARC_TESTNET, DEFAULT_FACILITATOR, KITE_TESTNET, settleScale, toAtomic, type Rail } from "./kite";
import { arcFacilitatorFromEnv } from "./arc-facilitator";

export const BUY_ROUTE = "GET /api/shops/:shop/v1/buy/:sku";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface SellerOptions {
  payTo?: string;
  facilitator?: FacilitatorClient;
  facilitatorUrl?: string;
  /** Facilitator for Arc testnet; null disables the Arc rail. Defaults to env (ARC_RELAYER_KEY). */
  arcFacilitator?: FacilitatorClient | null;
}

export function parseQty(raw: string | string[] | undefined | null): number {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const n = v == null || v === "" ? 1 : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 4) throw new Error("qty must be an integer 1–4");
  return n;
}

export function parseBuyPath(path: string): { shop: string; sku: string } | null {
  const m = /^\/api\/shops\/([a-z0-9-]{1,40})\/v1\/buy\/([a-z0-9-]{1,60})\/?$/.exec(path);
  return m ? { shop: m[1]!, sku: m[2]! } : null;
}

export function createSellerApp(opts: SellerOptions = {}): Hono {
  const payTo = opts.payTo ?? process.env.PAY_TO ?? "";
  const app = new Hono().basePath("/api/shops");
  app.use("*", secureHeaders());
  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "OPTIONS"],
      allowHeaders: ["Content-Type", "Payment-Signature", "X-Payment", "Idempotency-Key"],
      exposeHeaders: ["Payment-Required", "Payment-Response", "X-Payment-Response"],
    }),
  );

  const facilitator =
    opts.facilitator ?? new HTTPFacilitatorClient({ url: opts.facilitatorUrl ?? process.env.FACILITATOR_URL ?? DEFAULT_FACILITATOR });
  const arcFacilitator = opts.arcFacilitator === undefined ? arcFacilitatorFromEnv() : opts.arcFacilitator;
  const rails: Rail[] = arcFacilitator ? [KITE_TESTNET, ARC_TESTNET] : [KITE_TESTNET];
  const server = new x402ResourceServer(arcFacilitator ? [facilitator, arcFacilitator] : facilitator).register(
    KITE_TESTNET.network,
    new ExactEvmScheme(),
  );
  if (arcFacilitator) server.register(ARC_TESTNET.network, new ExactEvmScheme());
  const priceFor = (rail: Rail) => (ctx: { path: string; adapter: { getQueryParam?(n: string): string | string[] | undefined } }) => {
    const parsed = parseBuyPath(ctx.path)!;
    const product = productBySku(parsed.sku)!;
    const qty = parseQty(ctx.adapter.getQueryParam?.("qty"));
    return {
      asset: rail.asset,
      amount: toAtomic(product.price * qty, settleScale(), rail.decimals),
      extra: { name: rail.name, version: rail.version },
    };
  };
  const httpServer = new x402HTTPResourceServer(server, {
    [BUY_ROUTE]: {
      accepts: rails.map((rail) => ({
        scheme: "exact",
        network: rail.network,
        payTo,
        maxTimeoutSeconds: 120,
        price: priceFor(rail),
      })),
      description: "On My Tab demo seller (testnet). Seeded item, not a real merchant.",
      mimeType: "application/json",
      unpaidResponseBody: (ctx) => {
        const parsed = parseBuyPath(ctx.path)!;
        const p = productBySku(parsed.sku)!;
        const qty = parseQty(ctx.adapter.getQueryParam?.("qty"));
        return {
          contentType: "application/json",
          body: {
            demoSeller: true,
            shop: SHOPS[p.shop].name,
            sku: p.sku,
            title: p.title,
            qty,
            unitPriceUsd: p.price,
            totalUsd: Math.round(p.price * qty * 100) / 100,
            settleScale: settleScale(),
            rails: rails.map((r) => `${r.network} ${r.symbol}`),
            note: "Pay this 402 with x402 v2 exact. Testnet only.",
          },
        };
      },
    },
  });
  const payments = paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false);
  let init: Promise<void> | undefined;

  app.get("/", (c) =>
    c.json({
      demo: true,
      note: "Demo sellers for On My Tab. Our own endpoints on Kite testnet — not real merchants.",
      networks: rails.map((r) => ({ network: r.network, asset: r.symbol, address: r.asset, decimals: r.decimals })),
      payTo: ADDRESS.test(payTo) ? payTo : null,
      settleScale: settleScale(),
      shops: Object.values(SHOPS),
      products: PRODUCTS.map((p) => ({ ...p, endpoint: `/api/shops/${p.shop}/v1/buy/${p.sku}` })),
    }),
  );

  app.get("/.well-known/x402", (c) =>
    c.json({
      x402Version: 2,
      scheme: "exact",
      network: KITE_TESTNET.network,
      asset: { address: KITE_TESTNET.asset, symbol: KITE_TESTNET.symbol, decimals: KITE_TESTNET.decimals },
      accepts: rails.map((r) => ({ network: r.network, asset: r.asset, symbol: r.symbol, decimals: r.decimals })),
      payTo: ADDRESS.test(payTo) ? payTo : null,
      resources: PRODUCTS.map((p) => ({
        path: `/api/shops/${p.shop}/v1/buy/${p.sku}`,
        method: "GET",
        priceUsd: p.price,
        settleAtomic: toAtomic(p.price),
      })),
    }),
  );

  app.use("/:shop/v1/buy/:sku", async (c, next) => {
    const { shop, sku } = c.req.param();
    const product = productBySku(sku);
    if (!product || product.shop !== (shop as ShopId)) return c.json({ error: "unknown_item" }, 404);
    try {
      parseQty(c.req.query("qty"));
    } catch {
      return c.json({ error: "bad_qty" }, 400);
    }
    if (!ADDRESS.test(payTo)) return c.json({ error: "seller_not_configured" }, 503);
    try {
      init ??= httpServer.initialize().catch((e) => {
        init = undefined;
        throw e;
      });
      await init;
    } catch {
      return c.json({ error: "facilitator_unavailable" }, 503);
    }
    return payments(c, next);
  });

  app.get("/:shop/v1/buy/:sku", (c) => {
    const { sku } = c.req.param();
    const product = productBySku(sku)!;
    const qty = parseQty(c.req.query("qty"));
    return c.json({
      ok: true,
      demoSeller: true,
      order: {
        id: `omt_${crypto.randomUUID().slice(0, 8)}`,
        shop: SHOPS[product.shop].name,
        sku,
        title: product.title,
        qty,
        totalUsd: Math.round(product.price * qty * 100) / 100,
        fulfilment: "Demo seller: no physical goods ship. Settlement is real, on a testnet.",
      },
    });
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  return app;
}

let shared: Hono | undefined;
export function sellerApp(): Hono {
  shared ??= createSellerApp();
  return shared;
}
