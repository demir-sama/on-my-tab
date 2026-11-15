// In-process x402 facilitator for Arc testnet (eip155:5042002).
// Pieverse does not list Arc testnet, and the Kite Passport dev environment only
// pays there, so we verify + settle EIP-3009 USDC authorisations ourselves with a
// throwaway TESTNET relayer key (gas on Arc is paid in test USDC).
import type { FacilitatorClient } from "@x402/core/server";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { ARC_TESTNET } from "./kite";

export function arcRelayerAddress(): string | null {
  const key = process.env.ARC_RELAYER_KEY;
  return key && /^0x[0-9a-fA-F]{64}$/.test(key) ? privateKeyToAccount(key as `0x${string}`).address : null;
}

export function arcFacilitatorFromEnv(): FacilitatorClient | null {
  if (process.env.ARC_RAIL !== "on") return null; // off until the relayer holds Arc test USDC for gas
  const key = process.env.ARC_RELAYER_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) return null;
  const account = privateKeyToAccount(key as `0x${string}`);
  const client = createWalletClient({ account, chain: arcTestnet, transport: http(process.env.ARC_RPC_URL || undefined) }).extend(publicActions);
  const signer = toFacilitatorEvmSigner(Object.assign(client, { address: account.address }) as never, { confirmationTimeoutMs: 60_000 });
  const facilitator = new x402Facilitator().register(ARC_TESTNET.network, new ExactEvmScheme(signer));
  return {
    getSupported: async () => facilitator.getSupported() as never,
    verify: (p, r) => facilitator.verify(p, r),
    settle: (p, r) => facilitator.settle(p, r),
  };
}
