// Receipts for paid lines. Shared shape for the API and the UI.
//   live     — settled for THIS run on Arc testnet by /api/settle (real tx, fresh hash).
//   recorded — a real Arc testnet tx from the Nov 15 gift run, shown ONLY as a labelled fallback
//              when live settlement is capped, switched off, or failed. Never passed off as this run's.
//   none     — nothing settled on-chain for this line (with the reason).
import live from "@/data/live-receipts.json";
import { ARC_TESTNET, railByNetwork, txUrl } from "./kite";

export type ReceiptMode = "live" | "recorded" | "none";

export interface Receipt {
  sku: string;
  mode: ReceiptMode;
  /** The tab amount in display dollars. */
  displayUsd: number;
  /** What actually moved on-chain, in test USDC (decimal string), when something did. */
  onchain?: string;
  symbol?: string;
  network?: string;
  ref?: string;
  url?: string;
  at?: string;
  /** Why this isn't a live settlement (fallbacks only). */
  note?: string;
}

interface LiveEntry {
  tx: string;
  at: string;
  network?: string;
  via?: string;
  payer?: string;
  totalUsd?: number;
}

const store = live as { settleScale?: number; bySku: Record<string, LiveEntry> };
const bySku = store.bySku ?? {};
const RECORDED_SCALE = store.settleScale ?? 0.01;

/** Display dollars → test-token decimal string at a settle scale (exact cents math, trailing zeros trimmed). */
export function onchainAmount(displayUsd: number, scale: number, decimals = 6): string {
  const cents = BigInt(Math.round(displayUsd * 100));
  const scaleMicro = BigInt(Math.round(scale * 1_000_000));
  const atomic = (cents * 10n ** BigInt(decimals - 2) * scaleMicro) / 1_000_000n;
  const s = atomic.toString().padStart(decimals + 1, "0");
  const out = `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, "");
  return out === "" ? "0" : out;
}

export function liveReceipt(sku: string, displayUsd: number, tx: string, onchain: string, at = new Date().toISOString()): Receipt {
  return { sku, mode: "live", displayUsd, onchain, symbol: ARC_TESTNET.symbol, network: ARC_TESTNET.label, ref: tx, url: txUrl(tx, ARC_TESTNET), at };
}

/** The labelled fallback: a recorded real tx for the same item and amount if we have one, else "none". */
export function fallbackReceipt(sku: string, displayUsd: number, note: string): Receipt {
  const rec = bySku[sku];
  if (rec && /^0x[0-9a-fA-F]{64}$/.test(rec.tx) && (rec.totalUsd === undefined || rec.totalUsd === displayUsd)) {
    const rail = railByNetwork(rec.network ?? "") ?? ARC_TESTNET;
    return {
      sku,
      mode: "recorded",
      displayUsd,
      onchain: onchainAmount(displayUsd, RECORDED_SCALE, rail.decimals),
      symbol: rail.symbol,
      network: rail.label,
      ref: rec.tx,
      url: txUrl(rec.tx, rail),
      at: rec.at,
      note,
    };
  }
  return { sku, mode: "none", displayUsd, note };
}

export const recordedReceiptCount = () => Object.keys(bySku).length;
