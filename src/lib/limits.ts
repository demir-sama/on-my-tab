// Spend and rate limits for live testnet settlement and live SERV calls.
// Pure config + helpers; storage lives in ./store.ts.
import { createHash } from "node:crypto";

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

export interface Limits {
  /** Max test USDC (atomic, 6 decimals) the demo buyer may settle per rolling 24h, across all visitors. */
  dailySettleAtomic: bigint;
  /** Max settled lines per rolling 24h across everyone (bounds relayer gas). */
  dailySettleCount: number;
  /** Max distinct runs one visitor may settle live per rolling hour. */
  visitorRunsPerHour: number;
  /** Max settled lines one visitor may trigger per rolling 24h. */
  visitorLinesPerDay: number;
  /** Max live SERV calls per rolling 24h across everyone (our SERV credit is small). */
  servDaily: number;
  /** Max live SERV calls per visitor per rolling hour. */
  servVisitorPerHour: number;
  /** How long a SERV plan stays cached, in seconds. */
  servCacheTtlSec: number;
}

export function limitsFromEnv(env: Record<string, string | undefined> = process.env): Limits {
  const usdc = num(env.DAILY_SETTLE_CAP_USDC, 2);
  return {
    dailySettleAtomic: BigInt(Math.round(usdc * 1_000_000)),
    dailySettleCount: num(env.DAILY_SETTLE_MAX_LINES, 300),
    visitorRunsPerHour: num(env.VISITOR_RUNS_PER_HOUR, 3),
    visitorLinesPerDay: num(env.VISITOR_LINES_PER_DAY, 30),
    servDaily: num(env.SERV_DAILY_LIMIT, 40),
    servVisitorPerHour: num(env.SERV_VISITOR_PER_HOUR, 4),
    servCacheTtlSec: num(env.SERV_CACHE_TTL_SEC, 6 * 3600),
  };
}

/** Client IP as Vercel reports it. Vercel sets x-vercel-forwarded-for / x-real-ip itself, so a client can't spoof them. */
export function clientIp(headers: Headers): string {
  const raw = headers.get("x-vercel-forwarded-for") ?? headers.get("x-real-ip") ?? headers.get("x-forwarded-for") ?? "local";
  return raw.split(",")[0]!.trim() || "local";
}

/** IPv6 clients rotate addresses inside their /64, so rate-limit the /64; IPv4 stays as is. */
export function ipBucket(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const full = ip.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return `${full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** Salted, truncated hash so we never store raw IPs. */
export function visitorId(ip: string, salt = process.env.VISITOR_SALT ?? "omt-dev-salt"): string {
  return createHash("sha256").update(`${salt}:${ipBucket(ip)}`).digest("hex").slice(0, 24);
}

export type DenyReason = "daily_cap" | "daily_lines" | "visitor_runs" | "visitor_lines" | "duplicate" | "disabled";

export const DENY_COPY: Record<DenyReason, string> = {
  daily_cap: "Today's live test-USDC budget is used up.",
  daily_lines: "Today's live settlement count is used up.",
  visitor_runs: "You've settled a few runs live this hour.",
  visitor_lines: "You've hit today's live settlement limit.",
  duplicate: "This line was already settled for this run.",
  disabled: "Live settlement is switched off.",
};
