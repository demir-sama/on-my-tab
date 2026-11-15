// Preflight: ask every candidate seller for its price the x402 way — an unpaid
// GET that returns HTTP 402 with a Payment-Required challenge — and read the
// amount the seller actually demands (not what our catalog says it should be).
import type { Hono } from "hono";
import { productBySku, SHOPS } from "./catalog";
import type { Quote } from "./engine";
import { fromAtomic, KITE_TESTNET, settleScale } from "./kite";
import { sellerApp } from "./seller";

interface Challenge {
  x402Version: number;
  accepts: { scheme: string; network: string; asset: string; amount: string; payTo: string }[];
}

export function decodeChallenge(header: string | null): Challenge | null {
  if (!header) return null;
  try {
    const data = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Challenge;
    return data && Array.isArray(data.accepts) ? data : null;
  } catch {
    return null;
  }
}

export async function preflight(
  candidates: string[],
  qty: Record<string, number>,
  app: Hono = sellerApp(),
  origin = "https://on-my-tab.local",
): Promise<Quote[]> {
  const scale = settleScale();
  return Promise.all(
    candidates.map(async (sku) => {
      const p = productBySku(sku);
      if (!p) throw new Error(`unknown sku ${sku}`);
      const n = qty[sku] ?? 1;
      const path = `/api/shops/${p.shop}/v1/buy/${p.sku}${n > 1 ? `?qty=${n}` : ""}`;
      const base: Omit<Quote, "unitPrice" | "total" | "source"> = {
        sku,
        shop: p.shop,
        shopName: SHOPS[p.shop].name,
        title: p.title,
        group: p.group,
        extra: Boolean(p.extra),
        qty: n,
        reference: p.reference,
        endpoint: path,
      };
      try {
        const res = await app.request(new Request(origin + path, { headers: { accept: "application/json" } }));
        const ch = res.status === 402 ? decodeChallenge(res.headers.get("payment-required")) : null;
        const offer = ch?.accepts.find((a) => a.network === KITE_TESTNET.network && a.scheme === "exact");
        if (offer) {
          const total = Math.round((fromAtomic(offer.amount) / scale) * 100) / 100;
          return {
            ...base,
            unitPrice: Math.round((total / n) * 100) / 100,
            total,
            source: "x402" as const,
            network: offer.network,
            asset: offer.asset,
            amountAtomic: offer.amount,
            payTo: offer.payTo,
          };
        }
      } catch {
        /* fall through to catalog price */
      }
      return { ...base, unitPrice: p.price, total: Math.round(p.price * n * 100) / 100, source: "catalog" as const };
    }),
  );
}
