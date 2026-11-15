// Live settlement: the app's throwaway Arc TESTNET demo buyer pays one seller 402 for real,
// in-process: x402 client → our seller endpoint → 402 challenge → EIP-3009 signature →
// our Arc facilitator verifies and the relayer submits transferWithAuthorization.
import "server-only";
import type { Hono } from "hono";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { ARC_TESTNET } from "./kite";
import { sellerApp } from "./seller";

const KEY = /^0x[0-9a-fA-F]{64}$/;

export function liveSettleEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.LIVE_SETTLE === "on" && env.ARC_RAIL === "on" && KEY.test(env.ARC_BUYER_KEY ?? "") && /^0x[0-9a-fA-F]{40}$/.test(env.PAY_TO ?? "");
}

export function buyerAddress(): string | null {
  const k = process.env.ARC_BUYER_KEY;
  return k && KEY.test(k) ? privateKeyToAccount(k as `0x${string}`).address : null;
}

export interface Settled {
  tx: string;
  network: string;
  payer: string;
  amountAtomic: string;
}

/** Pay exactly `amountAtomic` test USDC for `endpointPath` on Arc testnet. Refuses any other network, amount or payee. */
export async function settleOnArc(endpointPath: string, amountAtomic: string, app: Hono = sellerApp()): Promise<Settled> {
  if (arcTestnet.id !== 5042002) throw new Error("refusing: not Arc testnet");
  const key = process.env.ARC_BUYER_KEY;
  const payTo = (process.env.PAY_TO ?? "").toLowerCase();
  if (!key || !KEY.test(key)) throw new Error("buyer not configured");
  const account = privateKeyToAccount(key as `0x${string}`);
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(process.env.ARC_RPC_URL || undefined) }).extend(publicActions);
  const client = new x402Client()
    .register(ARC_TESTNET.network, new ExactEvmScheme(toClientEvmSigner(Object.assign(wallet, { address: account.address }) as never)))
    // Belt and braces: only ever sign the exact Arc testnet amount we expect, to our own seller.
    .registerPolicy((_v, reqs) =>
      reqs.filter((r) => r.network === ARC_TESTNET.network && String(r.amount) === amountAtomic && String(r.payTo).toLowerCase() === payTo && String(r.asset).toLowerCase() === ARC_TESTNET.asset.toLowerCase()),
    );
  const inProcess: typeof fetch = async (input, init) => app.request(new Request(input as RequestInfo, init));
  const pay = wrapFetchWithPayment(inProcess, client);
  const res = await pay(`https://on-my-tab.local${endpointPath}`, { headers: { accept: "application/json" } });
  const header = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
  const settle = header ? (JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { success?: boolean; transaction?: string; network?: string; errorReason?: string }) : null;
  if (res.status !== 200 || !settle?.transaction || !/^0x[0-9a-fA-F]{64}$/.test(settle.transaction)) {
    const body = await res.text().catch(() => "");
    throw new Error(`settle failed (${res.status}${settle?.errorReason ? `, ${settle.errorReason}` : ""}) ${body.slice(0, 120)}`);
  }
  return { tx: settle.transaction, network: settle.network ?? ARC_TESTNET.network, payer: account.address, amountAtomic };
}
