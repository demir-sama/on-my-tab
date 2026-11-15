// Payment rails. TESTNETS ONLY — there is deliberately no mainnet config in this app.
//
// kite: Kite AI testnet (chain 2368), pieUSD, settled by the Pieverse facilitator.
//       Constants mirror BrKDDD/kite-x402-hono `KITE_NETWORKS.testnet`.
// arc:  Arc testnet (chain 5042002), Circle USDC (EIP-3009), the only chain the
//       Kite Passport DEV environment pays on. No public facilitator serves it, so
//       the app runs its own in-process x402 facilitator with a throwaway testnet relayer.

export interface Rail {
  id: "kite" | "arc";
  label: string;
  network: `eip155:${number}`;
  chainId: number;
  asset: `0x${string}`;
  symbol: string;
  decimals: number;
  /** EIP-712 domain for transferWithAuthorization */
  name: string;
  version: string;
  explorer: string;
}

export const KITE_TESTNET: Rail = {
  id: "kite",
  label: "Kite testnet",
  network: "eip155:2368",
  chainId: 2368,
  asset: "0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A",
  symbol: "pieUSD",
  decimals: 18,
  name: "pieUSD",
  version: "1",
  explorer: "https://testnet.kitescan.ai",
};

export const ARC_TESTNET: Rail = {
  id: "arc",
  label: "Arc testnet",
  network: "eip155:5042002",
  chainId: 5042002,
  asset: "0x3600000000000000000000000000000000000000",
  symbol: "USDC",
  decimals: 6,
  name: "USDC",
  version: "2",
  explorer: "https://explorer.testnet.arc.io",
};

export const RAILS = { kite: KITE_TESTNET, arc: ARC_TESTNET } as const;

export function railByNetwork(network: string): Rail | undefined {
  return Object.values(RAILS).find((r) => r.network === network);
}

export const DEFAULT_FACILITATOR = "https://facilitator.pieverse.io/v2";

export function settleScale(): number {
  const raw = Number(process.env.SETTLE_SCALE ?? "0.01");
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.01;
}

/** Dollars → atomic token units after the demo settle scale. Exact integer math. */
export function toAtomic(dollars: number, scale = settleScale(), decimals = KITE_TESTNET.decimals): string {
  const centsInt = BigInt(Math.round(dollars * 100));
  const scaleMicro = BigInt(Math.round(scale * 1_000_000));
  if (decimals < 2) throw new Error("decimals too small");
  const atomic = (centsInt * 10n ** BigInt(decimals - 2) * scaleMicro) / 1_000_000n;
  if (atomic <= 0n) throw new Error("amount must be positive");
  return atomic.toString();
}

export function fromAtomic(atomic: string, decimals = KITE_TESTNET.decimals): number {
  const v = BigInt(atomic);
  const shift = decimals > 6 ? 10n ** BigInt(decimals - 6) : 1n;
  const micro = decimals > 6 ? v / shift : v * 10n ** BigInt(6 - decimals);
  return Number(micro) / 1_000_000;
}

export const txUrl = (hash: string, rail: Rail = KITE_TESTNET) => `${rail.explorer}/tx/${hash}`;
export const addressUrl = (a: string, rail: Rail = KITE_TESTNET) => `${rail.explorer}/address/${a}`;
