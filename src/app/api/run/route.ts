import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import recorded from "@/data/serv-recorded.json";
import { BRIEFS, candidatesForWant } from "@/lib/catalog";
import { enforce, fallbackPlan, type Plan } from "@/lib/engine";
import { ARC_TESTNET, settleScale } from "@/lib/kite";
import { clientIp, limitsFromEnv, visitorId } from "@/lib/limits";
import { preflight } from "@/lib/quotes";
import { issueRunToken } from "@/lib/run-token";
import { servConfigured, servPlan, type ServMeta } from "@/lib/serv";
import { liveSettleEnabled } from "@/lib/settle";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  want: z.string().trim().min(3).max(240),
  cap: z.number().finite().min(1).max(500),
});

type Recorded = Record<string, { plan: Plan; meta: ServMeta; recordedAt: string }>;
const RECORDED = recorded as Recorded;

export type PlanSource = "serv-live" | "serv-cached" | "serv-recorded" | "fallback";

export async function POST(req: Request) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Give me a want (3–240 chars) and a cap between $1 and $500." }, { status: 400 });
  }
  const { want, cap } = body;
  const visitor = visitorId(clientIp(req.headers));
  const limits = limitsFromEnv();
  const store = getStore();

  const { candidates, qty } = candidatesForWant(want);
  const quotes = await preflight(candidates, qty);
  const preset = BRIEFS.find((b) => b.want === want);

  let plan: Plan | null = null;
  let planSource: PlanSource = "fallback";
  let meta: (ServMeta & { recordedAt?: string; cachedAt?: string }) | null = null;
  let servNote: string | null = null;

  // Cache by brief + the live quotes (the cap is enforced by code, not by the plan).
  const key = createHash("sha256")
    .update(JSON.stringify([want.toLowerCase().replace(/\s+/g, " "), quotes.map((q) => [q.sku, q.total])]))
    .digest("hex");

  const cached = await store.getPlan(key, limits.servCacheTtlSec).catch(() => null);
  if (cached) {
    plan = cached.plan;
    meta = { ...cached.meta, cachedAt: cached.at };
    planSource = "serv-cached";
  } else if (servConfigured() && (await store.takeServCall(visitor, limits).catch(() => false))) {
    try {
      const out = await servPlan(want, cap, quotes);
      plan = out.plan;
      meta = out.meta;
      planSource = "serv-live";
      await store.putPlan(key, { plan, meta }).catch(() => undefined);
    } catch (e) {
      servNote = `SERV call failed (${e instanceof Error ? e.message.replace(/Bearer\s+\S+/g, "Bearer ***").slice(0, 80) : "error"}).`;
    }
  } else {
    servNote = servConfigured() ? "Live SERV budget for this demo is used up for now." : "SERV key not configured.";
  }

  if (!plan) {
    if (preset && RECORDED[preset.id]) {
      const r = RECORDED[preset.id]!;
      plan = r.plan;
      meta = { ...r.meta, recordedAt: r.recordedAt };
      planSource = "serv-recorded";
      servNote = `${servNote ?? ""} Showing a recorded real SERV response for this brief.`.trim();
    } else {
      plan = fallbackPlan(want, quotes, cap);
      planSource = "fallback";
      servNote = `${servNote ?? ""} Showing the rule-based plan.`.trim();
    }
  }

  const result = enforce(plan, quotes, cap);
  let token: string | null = null;
  let runId: string | null = null;
  try {
    ({ token, runId } = issueRunToken(result, visitor));
  } catch {
    /* no token secret: live settlement unavailable, UI falls back honestly */
  }

  return NextResponse.json({
    runId,
    token,
    want,
    cap,
    quotes,
    plan,
    planSource,
    meta,
    servError: servNote,
    result,
    settle: {
      live: Boolean(token) && liveSettleEnabled(),
      rail: ARC_TESTNET.label,
      symbol: ARC_TESTNET.symbol,
      scale: settleScale(),
    },
  });
}
