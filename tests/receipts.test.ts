import { describe, expect, it } from "vitest";
import { fallbackReceipt, liveReceipt, onchainAmount, recordedReceiptCount } from "@/lib/receipts";

const TX = `0x${"ab".repeat(32)}`;

describe("onchainAmount", () => {
  it("scales display dollars to test-token amounts exactly", () => {
    expect(onchainAmount(16, 0.001)).toBe("0.016");
    expect(onchainAmount(16, 0.01)).toBe("0.16");
    expect(onchainAmount(12.5, 0.001)).toBe("0.0125");
    expect(onchainAmount(0.01, 0.001)).toBe("0.00001");
    expect(onchainAmount(40, 1)).toBe("40");
    expect(onchainAmount(0, 0.001)).toBe("0");
  });
  it("avoids float drift", () => expect(onchainAmount(19.99, 0.001)).toBe("0.01999"));
});

describe("receipts", () => {
  it("live receipts carry both amounts and a fresh Arc testnet tx link", () => {
    const r = liveReceipt("pothos-ceramic", 16, TX, "0.016");
    expect(r).toMatchObject({ mode: "live", displayUsd: 16, onchain: "0.016", symbol: "USDC", network: "Arc testnet", ref: TX });
    expect(r.url).toBe(`https://explorer.testnet.arc.io/tx/${TX}`);
  });
  it("fallbacks are labelled RECORDED with the recorded scale, the reason, and the original date", () => {
    const r = fallbackReceipt("pothos-ceramic", 16, "Today's live test-USDC budget is used up.");
    expect(r.mode).toBe("recorded");
    expect(r.onchain).toBe("0.16");
    expect(r.note).toMatch(/budget/);
    expect(r.at).toMatch(/^2026-11-1/);
    expect(r.url).toMatch(/^https:\/\/explorer\.testnet\.arc\.io\/tx\/0x[0-9a-f]{64}$/);
  });
  it("never reuses a recorded tx for a different amount or unknown item", () => {
    expect(fallbackReceipt("pothos-ceramic", 17, "x").mode).toBe("none");
    expect(fallbackReceipt("no-such-sku", 5, "x")).toEqual({ sku: "no-such-sku", mode: "none", displayUsd: 5, note: "x" });
  });
  it("counts the recorded gift run", () => expect(recordedReceiptCount()).toBe(5));
});
