// Durable counters for the spend cap, rate limits and SERV cache.
// Postgres (Neon, via DATABASE_URL) in production; an in-memory store for tests and local dev.
import "server-only";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { Plan } from "./engine";
import type { ServMeta } from "./serv";
import type { DenyReason, Limits } from "./limits";

export interface ReserveInput {
  runId: string;
  sku: string;
  visitor: string;
  amountAtomic: bigint;
}
export type ReserveResult = { ok: true; id: number } | { ok: false; reason: DenyReason };

export interface CachedPlan {
  plan: Plan;
  meta: ServMeta;
  at: string;
}

export interface Store {
  kind: "postgres" | "memory";
  /** Atomically check every limit and record a pending settlement. */
  reserve(input: ReserveInput, limits: Limits): Promise<ReserveResult>;
  markSettled(id: number, tx: string): Promise<void>;
  /** Failed settlements stop counting toward the caps. */
  markFailed(id: number, error: string): Promise<void>;
  usage(): Promise<{ settledAtomic24h: bigint; lines24h: number }>;
  getPlan(key: string, ttlSec: number): Promise<CachedPlan | null>;
  putPlan(key: string, value: Omit<CachedPlan, "at">): Promise<void>;
  /** Reserve a live SERV call if both the global and the per-visitor budget allow it. */
  takeServCall(visitor: string, limits: Limits): Promise<boolean>;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function memoryStore(now: () => number = Date.now): Store {
  const rows: { id: number; runId: string; sku: string; visitor: string; amount: bigint; status: "pending" | "settled" | "failed"; at: number; tx?: string }[] = [];
  const plans = new Map<string, CachedPlan & { ts: number }>();
  const serv: { visitor: string; at: number }[] = [];
  let seq = 0;
  const live = () => rows.filter((r) => r.status !== "failed" && r.at > now() - DAY);
  return {
    kind: "memory",
    async reserve(i, l) {
      if (rows.some((r) => r.runId === i.runId && r.sku === i.sku && r.status !== "failed")) return { ok: false, reason: "duplicate" };
      const day = live();
      if (day.reduce((s, r) => s + r.amount, 0n) + i.amountAtomic > l.dailySettleAtomic) return { ok: false, reason: "daily_cap" };
      if (day.length >= l.dailySettleCount) return { ok: false, reason: "daily_lines" };
      const mine = day.filter((r) => r.visitor === i.visitor);
      if (mine.length >= l.visitorLinesPerDay) return { ok: false, reason: "visitor_lines" };
      const runsHour = new Set(mine.filter((r) => r.at > now() - HOUR).map((r) => r.runId));
      if (!runsHour.has(i.runId) && runsHour.size >= l.visitorRunsPerHour) return { ok: false, reason: "visitor_runs" };
      const id = ++seq;
      rows.push({ id, runId: i.runId, sku: i.sku, visitor: i.visitor, amount: i.amountAtomic, status: "pending", at: now() });
      return { ok: true, id };
    },
    async markSettled(id, tx) {
      const r = rows.find((x) => x.id === id);
      if (r) Object.assign(r, { status: "settled", tx });
    },
    async markFailed(id) {
      const r = rows.find((x) => x.id === id);
      if (r) r.status = "failed";
    },
    async usage() {
      const day = live();
      return { settledAtomic24h: day.reduce((s, r) => s + r.amount, 0n), lines24h: day.length };
    },
    async getPlan(key, ttl) {
      const p = plans.get(key);
      return p && p.ts > now() - ttl * 1000 ? { plan: p.plan, meta: p.meta, at: p.at } : null;
    },
    async putPlan(key, v) {
      plans.set(key, { ...v, at: new Date(now()).toISOString(), ts: now() });
    },
    async takeServCall(visitor, l) {
      const day = serv.filter((s) => s.at > now() - DAY);
      if (day.length >= l.servDaily) return false;
      if (day.filter((s) => s.visitor === visitor && s.at > now() - HOUR).length >= l.servVisitorPerHour) return false;
      serv.push({ visitor, at: now() });
      return true;
    },
  };
}

export function postgresStore(sql: NeonQueryFunction<false, false>): Store {
  return {
    kind: "postgres",
    async reserve(i, l) {
      const amt = i.amountAtomic.toString();
      const cap = l.dailySettleAtomic.toString();
      // Every check and the insert happen in ONE statement inside a transaction serialised by an
      // advisory lock, so concurrent requests can't both slip under the cap.
      const [, ins] = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(4021)`,
        sql`
          WITH day AS (
            SELECT COALESCE(SUM(amount_atomic), 0)::bigint AS amt, COUNT(*)::int AS n
            FROM settlements WHERE status <> 'failed' AND created_at > now() - interval '24 hours'
          ), mine AS (
            SELECT COUNT(*)::int AS n,
                   COUNT(DISTINCT run_id) FILTER (WHERE created_at > now() - interval '1 hour')::int AS runs_hour,
                   COALESCE(BOOL_OR(run_id = ${i.runId} AND created_at > now() - interval '1 hour'), false) AS same_run
            FROM settlements WHERE status <> 'failed' AND visitor = ${i.visitor} AND created_at > now() - interval '24 hours'
          )
          INSERT INTO settlements (run_id, sku, visitor, amount_atomic)
          SELECT ${i.runId}, ${i.sku}, ${i.visitor}, ${amt}::bigint
          FROM day, mine
          WHERE NOT EXISTS (SELECT 1 FROM settlements WHERE run_id = ${i.runId} AND sku = ${i.sku} AND status <> 'failed')
            AND day.amt + ${amt}::bigint <= ${cap}::bigint
            AND day.n < ${l.dailySettleCount}
            AND mine.n < ${l.visitorLinesPerDay}
            AND (mine.same_run OR mine.runs_hour < ${l.visitorRunsPerHour})
          ON CONFLICT (run_id, sku) DO UPDATE SET status = 'pending', error = NULL, tx = NULL, created_at = now(), visitor = EXCLUDED.visitor
            WHERE settlements.status = 'failed'
          RETURNING id
        `,
      ]);
      const id = (ins as { id: string | number }[])[0]?.id;
      if (id !== undefined) return { ok: true, id: Number(id) };
      // Denied: work out which limit for an honest message.
      const rows = (await sql`
        SELECT
          EXISTS (SELECT 1 FROM settlements WHERE run_id = ${i.runId} AND sku = ${i.sku} AND status <> 'failed') AS duplicate,
          (SELECT COALESCE(SUM(amount_atomic),0) FROM settlements WHERE status <> 'failed' AND created_at > now() - interval '24 hours') + ${amt}::bigint > ${cap}::bigint AS over_cap,
          (SELECT COUNT(*) FROM settlements WHERE status <> 'failed' AND created_at > now() - interval '24 hours') >= ${l.dailySettleCount} AS over_lines,
          (SELECT COUNT(*) FROM settlements WHERE status <> 'failed' AND visitor = ${i.visitor} AND created_at > now() - interval '24 hours') >= ${l.visitorLinesPerDay} AS over_visitor_lines
      `) as Record<string, boolean>[];
      const r = rows[0] ?? {};
      const reason: DenyReason = r.duplicate ? "duplicate" : r.over_cap ? "daily_cap" : r.over_lines ? "daily_lines" : r.over_visitor_lines ? "visitor_lines" : "visitor_runs";
      return { ok: false, reason };
    },
    async markSettled(id, tx) {
      await sql`UPDATE settlements SET status = 'settled', tx = ${tx}, settled_at = now() WHERE id = ${id}`;
    },
    async markFailed(id, error) {
      await sql`UPDATE settlements SET status = 'failed', error = ${error.slice(0, 300)} WHERE id = ${id}`;
    },
    async usage() {
      const rows = (await sql`SELECT COALESCE(SUM(amount_atomic),0)::text AS amt, COUNT(*)::int AS n FROM settlements WHERE status <> 'failed' AND created_at > now() - interval '24 hours'`) as { amt: string; n: number }[];
      return { settledAtomic24h: BigInt(rows[0]!.amt), lines24h: rows[0]!.n };
    },
    async getPlan(key, ttl) {
      const rows = (await sql`SELECT plan, meta, created_at FROM serv_cache WHERE key = ${key} AND created_at > now() - make_interval(secs => ${ttl})`) as { plan: Plan; meta: ServMeta; created_at: string | Date }[];
      const r = rows[0];
      return r ? { plan: r.plan, meta: r.meta, at: new Date(r.created_at).toISOString() } : null;
    },
    async putPlan(key, v) {
      await sql`INSERT INTO serv_cache (key, plan, meta) VALUES (${key}, ${JSON.stringify(v.plan)}::jsonb, ${JSON.stringify(v.meta)}::jsonb)
                ON CONFLICT (key) DO UPDATE SET plan = EXCLUDED.plan, meta = EXCLUDED.meta, created_at = now()`;
    },
    async takeServCall(visitor, l) {
      const rows = (await sql`
        INSERT INTO serv_calls (visitor)
        SELECT ${visitor}
        WHERE (SELECT COUNT(*) FROM serv_calls WHERE created_at > now() - interval '24 hours') < ${l.servDaily}
          AND (SELECT COUNT(*) FROM serv_calls WHERE visitor = ${visitor} AND created_at > now() - interval '1 hour') < ${l.servVisitorPerHour}
        RETURNING id`) as unknown[];
      return rows.length > 0;
    },
  };
}

let shared: Store | undefined;
export function getStore(): Store {
  if (shared) return shared;
  const url = process.env.DATABASE_URL;
  shared = url ? postgresStore(neon(url)) : memoryStore();
  return shared;
}
/** Test hook. */
export function setStore(s: Store | undefined) {
  shared = s;
}
