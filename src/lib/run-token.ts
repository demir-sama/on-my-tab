// Signed run tokens: /api/run hands the browser an HMAC-signed copy of the tab's lines,
// and /api/settle only pays lines that appear in a valid, unexpired token bound to the same visitor.
// The browser can't invent a line, change an amount, or replay someone else's run.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { TabResult, Verdict } from "./engine";

export interface TokenLine {
  sku: string;
  qty: number;
  total: number;
  verdict: Verdict;
}
export interface RunToken {
  v: 1;
  runId: string;
  visitor: string;
  cap: number;
  exp: number;
  lines: TokenLine[];
}

export const TOKEN_TTL_MS = 15 * 60_000;
const devSecret = randomBytes(32).toString("hex");

function secret(): string {
  const s = process.env.RUN_TOKEN_SECRET;
  if (s && s.length >= 32) return s;
  if (process.env.NODE_ENV === "production") throw new Error("RUN_TOKEN_SECRET missing");
  return devSecret;
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sign = (body: string, key: string) => createHmac("sha256", key).update(body).digest();

export function newRunId(): string {
  return `run_${randomBytes(9).toString("base64url")}`;
}

export function issueRunToken(result: TabResult, visitor: string, now = Date.now(), key = secret()): { token: string; runId: string } {
  const payload: RunToken = {
    v: 1,
    runId: newRunId(),
    visitor,
    cap: result.cap,
    exp: now + TOKEN_TTL_MS,
    lines: result.lines.filter((l) => l.verdict === "PAID" || l.verdict === "HOLD").map((l) => ({ sku: l.sku, qty: l.qty, total: l.total, verdict: l.verdict })),
  };
  const body = b64u(JSON.stringify(payload));
  return { token: `${body}.${b64u(sign(body, key))}`, runId: payload.runId };
}

export type VerifyResult = { ok: true; run: RunToken } | { ok: false; error: "malformed" | "bad_signature" | "expired" | "wrong_visitor" };

export function verifyRunToken(token: string, visitor: string, now = Date.now(), key = secret()): VerifyResult {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 2 || !parts[0] || !parts[1] || token.length > 4000) return { ok: false, error: "malformed" };
  const [body, sig] = parts as [string, string];
  const want = sign(body, key);
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, error: "bad_signature" };
  let run: RunToken;
  try {
    run = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as RunToken;
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (run.v !== 1 || !Array.isArray(run.lines)) return { ok: false, error: "malformed" };
  if (run.exp < now) return { ok: false, error: "expired" };
  if (run.visitor !== visitor) return { ok: false, error: "wrong_visitor" };
  return { ok: true, run };
}

/** A line may be paid if the engine marked it PAID, or it was a HOLD and the user raised the tab. */
export function payableLine(run: RunToken, sku: string, raised: boolean): TokenLine | null {
  const line = run.lines.find((l) => l.sku === sku);
  if (!line) return null;
  if (line.verdict === "PAID") return line;
  if (line.verdict === "HOLD" && raised) return line;
  return null;
}
