import { NextResponse } from "next/server";
import { z } from "zod";
import recorded from "@/data/serv-recorded.json";
import { BRIEFS, candidatesForWant } from "@/lib/catalog";
import { enforce, fallbackPlan, type Plan } from "@/lib/engine";
import { settleScale, KITE_TESTNET } from "@/lib/kite";
import { preflight } from "@/lib/quotes";
import { receiptsFor } from "@/lib/receipts";
import { servConfigured, servPlan, type ServMeta } from "@/lib/serv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  want: z.string().trim().min(3).max(240),
  cap: z.number().finite().min(1).max(500),
});

type Recorded = Record<string, { plan: Plan; meta: ServMeta; recordedAt: string }>;
const RECORDED = recorded as Recorded;

// Frugal live-SERV guard: our credit balance is tiny, so cap live calls per instance and per IP.
const LIVE_LIMIT = Number(process.env.SERV_LIVE_LIMIT ?? 25);
let liveCalls = 0;
const perIp = new Map<string, { n: number; reset: number }>();
const cache = new Map<string, { plan: Plan; meta: ServMeta; at: string }>();

function ipAllowed(ip: string): boolean {
  const now = Date.now();
  const e = perIp.get(ip);
  if (!e || e.reset < now) {
    perIp.set(ip, { n: 1, reset: now + 3_600_000 });
    return true;
  }
  if (e.n >= 4) return false;
  e.n++;
  return true;
}

export async function POST(req: Request) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Give me a want (3–240 chars) and a cap between $1 and $500." }, { status: 400 });
  }
  const { want, cap } = body;

  const { candidates, qty } = candidatesForWant(want);
  const quotes = await preflight(candidates, qty);
  const preset = BRIEFS.find((b) => b.want === want);

  let plan: Plan;
  let planSource: "serv-live" | "serv-recorded" | "serv-cached" | "fallback";
  let meta: (ServMeta & { recordedAt?: string }) | null = null;
  let servError: string | null = null;

  const key = JSON.stringify([want.toLowerCase(), quotes.map((q) => [q.sku, q.total])]);
  if (preset && RECORDED[preset.id]) {
    const r = RECORDED[preset.id]!;
    plan = r.plan;
    meta = { ...r.meta, recordedAt: r.recordedAt };
    planSource = "serv-recorded";
  } else if (cache.has(key)) {
    const c = cache.get(key)!;
    plan = c.plan;
    meta = { ...c.meta, recordedAt: c.at };
    planSource = "serv-cached";
  } else {
    const ip = (req.headers.get("x-forwarded-for") ?? "local").split(",")[0]!.trim();
    const canCall = servConfigured() && liveCalls < LIVE_LIMIT && ipAllowed(ip);
    if (canCall) {
      try {
        liveCalls++;
        const out = await servPlan(want, cap, quotes);
        plan = out.plan;
        meta = out.meta;
        planSource = "serv-live";
        cache.set(key, { plan, meta, at: new Date().toISOString() });
      } catch (e) {
        servError = e instanceof Error ? e.message.replace(/Bearer\s+\S+/g, "Bearer ***") : "SERV failed";
        plan = fallbackPlan(want, quotes, cap);
        planSource = "fallback";
      }
    } else {
      servError = servConfigured() ? "Live SERV budget for this demo is used up — showing the rule-based plan." : "SERV key not configured.";
      plan = fallbackPlan(want, quotes, cap);
      planSource = "fallback";
    }
  }

  const result = enforce(plan, quotes, cap);
  return NextResponse.json({
    want,
    cap,
    quotes,
    plan,
    planSource,
    meta,
    servError,
    result,
    receipts: receiptsFor(result),
    network: { ...KITE_TESTNET, settleScale: settleScale(), payTo: process.env.PAY_TO ?? null },
  });
}
