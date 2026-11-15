import { NextResponse } from "next/server";
import { z } from "zod";
import { productBySku } from "@/lib/catalog";
import { ARC_TESTNET, settleScale, toAtomic } from "@/lib/kite";
import { clientIp, DENY_COPY, limitsFromEnv, visitorId } from "@/lib/limits";
import { fallbackReceipt, liveReceipt, onchainAmount } from "@/lib/receipts";
import { payableLine, verifyRunToken } from "@/lib/run-token";
import { liveSettleEnabled, settleOnArc } from "@/lib/settle";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  token: z.string().min(10).max(4000),
  sku: z.string().regex(/^[a-z0-9-]{1,60}$/),
  raised: z.boolean().optional().default(false),
});

// Serialise settlements within an instance so the relayer never races its own nonce.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

export async function POST(req: Request) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const visitor = visitorId(clientIp(req.headers));
  let v: ReturnType<typeof verifyRunToken>;
  try {
    v = verifyRunToken(body.token, visitor);
  } catch {
    return NextResponse.json({ error: "settlement_unavailable" }, { status: 503 });
  }
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: v.error === "expired" ? 410 : 403 });
  const line = payableLine(v.run, body.sku, body.raised);
  const product = productBySku(body.sku);
  if (!line || !product) return NextResponse.json({ error: "not_payable" }, { status: 400 });

  if (!liveSettleEnabled()) {
    return NextResponse.json({ receipt: fallbackReceipt(line.sku, line.total, DENY_COPY.disabled) });
  }

  const scale = settleScale();
  const amountAtomic = toAtomic(line.total, scale, ARC_TESTNET.decimals);
  const store = getStore();
  const reserved = await store.reserve({ runId: v.run.runId, sku: line.sku, visitor, amountAtomic: BigInt(amountAtomic) }, limitsFromEnv()).catch(() => null);
  if (!reserved) return NextResponse.json({ receipt: fallbackReceipt(line.sku, line.total, "Spend-cap ledger unavailable, so nothing was paid live.") });
  if (!reserved.ok) {
    // A repeat request for a line we already paid isn't a cap problem: don't dress it up as a fallback.
    if (reserved.reason === "duplicate") return NextResponse.json({ receipt: { sku: line.sku, mode: "none", displayUsd: line.total, note: DENY_COPY.duplicate } }, { status: 409 });
    return NextResponse.json({ receipt: fallbackReceipt(line.sku, line.total, DENY_COPY[reserved.reason]) });
  }

  const path = `/api/shops/${product.shop}/v1/buy/${product.sku}${line.qty > 1 ? `?qty=${line.qty}` : ""}`;
  try {
    const s = await serial(() => settleOnArc(path, amountAtomic));
    await store.markSettled(reserved.id, s.tx).catch(() => undefined);
    return NextResponse.json({ receipt: liveReceipt(line.sku, line.total, s.tx, onchainAmount(line.total, scale)) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "settle failed";
    await store.markFailed(reserved.id, msg).catch(() => undefined);
    return NextResponse.json({ receipt: fallbackReceipt(line.sku, line.total, "Live settlement didn't go through this time.") });
  }
}
