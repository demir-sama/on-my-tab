import live from "@/data/live-receipts.json";
import type { TabResult } from "./engine";
import { KITE_TESTNET, railByNetwork, txUrl } from "./kite";

export interface Receipt {
  sku: string;
  mode: "testnet" | "seeded";
  network?: string;
  via?: string;
  ref: string;
  url?: string;
  at?: string;
  payer?: string;
  payerLabel?: string;
}

interface LiveEntry {
  tx: string;
  at: string;
  network?: string;
  via?: string;
  payer?: string;
  totalUsd?: number;
}

/** Who actually paid, in plain words. The live demo never claims Passport paid unless it did. */
export const PAYER_LABELS: Record<string, string> = {
  "demo-buyer-wallet-arc": "demo buyer wallet (Arc testnet), not Passport",
  "demo-buyer-key": "demo buyer wallet (Kite testnet), not Passport",
  "kite-passport-dev": "Kite Passport session (dev, Arc testnet)",
};

const bySku = (live as { bySku: Record<string, LiveEntry> }).bySku ?? {};

function seededRef(seed: string): string {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return `SEEDED-${(h >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

/** Receipts for every payable line (the UI shows them once a line is PAID). Real tx where a recorded Kite testnet settlement exists for this exact item+amount; otherwise a clearly seeded ref. */
export function receiptsFor(result: TabResult): Receipt[] {
  return result.lines
    .filter((l) => l.verdict !== "REFUSED")
    .map((l) => {
      const rec = bySku[l.sku];
      if (rec && /^0x[0-9a-fA-F]{64}$/.test(rec.tx) && (rec.totalUsd === undefined || rec.totalUsd === l.total)) {
        const rail = railByNetwork(rec.network ?? "") ?? KITE_TESTNET;
        return { sku: l.sku, mode: "testnet", ref: rec.tx, url: txUrl(rec.tx, rail), at: rec.at, payer: rec.payer, network: rail.label, via: rec.via, payerLabel: PAYER_LABELS[rec.via ?? ""] ?? "demo buyer wallet, not Passport" };
      }
      return { sku: l.sku, mode: "seeded", ref: seededRef(`${l.sku}:${l.total}`) };
    });
}

export const liveReceiptCount = () => Object.keys(bySku).length;
