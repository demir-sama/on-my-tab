#!/usr/bin/env node
// Real-pay runner for On My Tab. TESTNET ONLY.
//
// Runs a tab against the deployed app, then pays every PAID line for real:
//   --via passport : Kite Passport (DEV env) session pays each seller's 402 on Arc testnet USDC.
//                    Requires: kpass logged in with KITE_PASSPORT_BASE_URL=https://passport.dev.gokite.ai
//                    and a session approved by the owner's passkey (see README).
//   --via arc-key  : a throwaway Arc testnet DEMO BUYER wallet (not Passport) pays each seller's 402 on
//                    Arc testnet USDC through the app's self-hosted facilitator. Key: ARC_BUYER_KEY in .env.
//                    (Kite's dev Passport refuses hosts outside its curated catalog: host_not_in_executable_catalog.)
//   --via key      : a throwaway testnet buyer key pays on Kite testnet (eip155:2368, pieUSD)
//                    via the Pieverse facilitator. Key file: ../.secrets/kite-buyer-testnet.json
// Writes confirmed tx hashes to src/data/live-receipts.json (no secrets).
//
// Usage: node scripts/pay.mjs --base https://<app> --brief gift|night [--via passport|key] [--raise] [--dry]
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, http, parseAbiItem } from "viem";
import { arcTestnet } from "viem/chains";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
    return acc;
  }, []),
);
const base = String(args.base ?? "").replace(/\/$/, "");
const via = args.via ?? "passport";
if (!/^https?:\/\//.test(base)) throw new Error("--base https://… required");
if (!["passport", "key", "arc-key"].includes(via)) throw new Error("--via passport|key|arc-key");

const BRIEFS = {
  gift: { want: "A birthday gift for my sister Ama. She loves plants and journaling. Wrap it nicely, and get it to her today if you can.", cap: 40 },
  night: { want: "Two tickets to the Saturday show, something to eat after, and a ride home. Upgrade us to balcony seats if you can.", cap: 60 },
};
const brief = BRIEFS[args.brief ?? "gift"];
if (!brief) throw new Error("--brief gift|night");

const ARC = { network: "eip155:5042002", usdc: "0x3600000000000000000000000000000000000000" };
const KITE = { network: "eip155:2368" };

const run = await (await fetch(`${base}/api/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(brief) })).json();
if (!run.result) throw new Error(`run failed: ${JSON.stringify(run).slice(0, 200)}`);
const lines = run.result.lines.filter((l) => l.verdict === "PAID" || (args.raise && l.verdict === "HOLD"));
const quotes = Object.fromEntries(run.quotes.map((q) => [q.sku, q]));
console.log(`Plan via ${run.planSource}. Paying ${lines.length} item(s): ${lines.map((l) => `${l.sku} $${l.total}`).join(", ")}`);
console.log(`Refused: ${run.result.lines.filter((l) => l.verdict === "REFUSED").map((l) => l.sku).join(", ") || "none"}`);
if (args.dry) process.exit(0);

const receiptsPath = new URL("../src/data/live-receipts.json", import.meta.url);
const store = JSON.parse(readFileSync(receiptsPath, "utf8"));
store.bySku ??= {};
const payTo = run.network.payTo;

async function findArcTx(from, amountAtomic, sinceBlock) {
  const client = createPublicClient({ chain: arcTestnet, transport: http() });
  const event = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
  for (let i = 0; i < 20; i++) {
    const logs = await client.getLogs({ address: ARC.usdc, event, args: { from, to: payTo }, fromBlock: sinceBlock });
    const hit = logs.reverse().find((l) => l.args.value === BigInt(amountAtomic));
    if (hit) return hit.transactionHash;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

let payWithKey;
if (via === "key") {
  const { wrapFetchWithPayment, x402Client } = await import("@x402/fetch");
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  const { toClientEvmSigner } = await import("@x402/evm");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { createWalletClient, publicActions, defineChain } = await import("viem");
  const secret = JSON.parse(readFileSync(new URL("../../.secrets/kite-buyer-testnet.json", import.meta.url), "utf8"));
  const account = privateKeyToAccount(secret.privateKey);
  const kite = defineChain({ id: 2368, name: "KiteAI Testnet", nativeCurrency: { name: "KITE", symbol: "KITE", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc-testnet.gokite.ai/"] } } });
  const wallet = createWalletClient({ account, chain: kite, transport: http() }).extend(publicActions);
  const client = new x402Client().register(KITE.network, new ExactEvmScheme(toClientEvmSigner(Object.assign(wallet, { address: account.address }))));
  const pay = wrapFetchWithPayment(fetch, client);
  payWithKey = async (url) => {
    const res = await pay(url);
    const header = res.headers.get("payment-response");
    const settle = header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : null;
    return { status: res.status, body: await res.json().catch(() => null), tx: settle?.transaction, payer: account.address, network: KITE.network };
  };
}

if (via === "arc-key") {
  const { wrapFetchWithPayment, x402Client } = await import("@x402/fetch");
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  const { toClientEvmSigner } = await import("@x402/evm");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { createWalletClient, publicActions } = await import("viem");
  const env = Object.fromEntries(readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n").filter((x) => /^[A-Z_]+=/.test(x)).map((x) => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1).replace(/^"|"$/g, "")]));
  if (!/^0x[0-9a-fA-F]{64}$/.test(env.ARC_BUYER_KEY ?? "")) throw new Error("ARC_BUYER_KEY missing in .env");
  if (arcTestnet.id !== 5042002) throw new Error("refusing: not Arc testnet");
  const account = privateKeyToAccount(env.ARC_BUYER_KEY);
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: http() }).extend(publicActions);
  const client = new x402Client().register(ARC.network, new ExactEvmScheme(toClientEvmSigner(Object.assign(wallet, { address: account.address }))));
  const pay = wrapFetchWithPayment(fetch, client);
  payWithKey = async (url) => {
    const res = await pay(url);
    const header = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
    const settle = header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : null;
    const body = await res.json().catch(() => null);
    if (res.status >= 300) console.log(`  HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    return { status: res.status, body, tx: settle?.transaction, payer: account.address, network: settle?.network ?? ARC.network };
  };
}

for (const l of lines) {
  const q = quotes[l.sku];
  const url = `${base}${q.endpoint}`;
  const key = `omt-${args.brief ?? "gift"}-${l.sku}-${Date.now()}`;
  console.log(`\n→ ${l.sku} (${q.shopName}) $${l.total}  ${url}`);
  let rec;
  if (via === "passport") {
    const arc = createPublicClient({ chain: arcTestnet, transport: http() });
    const since = (await arc.getBlockNumber()) - 5n;
    const kargs = ["session", "execute", "--url", url, "--method", "GET", "--idempotency-key", key, "--no-browser", "--output", "json"];
    if (args.session) kargs.push("--session-id", String(args.session));
    let out;
    try {
      out = execFileSync("kpass", kargs, {
      env: { ...process.env, KITE_PASSPORT_BASE_URL: process.env.KITE_PASSPORT_BASE_URL ?? "https://passport.dev.gokite.ai" },
      encoding: "utf8",
      timeout: 300_000,
      });
    } catch (e) {
      out = String(e.stdout ?? "");
      console.log(`  kpass exited ${e.status}: ${out.slice(0, 600)}`);
      process.exit(1);
    }
    appendFileSync(new URL("../../qa/pay-log.jsonl", import.meta.url), JSON.stringify({ sku: l.sku, at: new Date().toISOString(), out: JSON.parse(out) }) + "\n");
    const res = JSON.parse(out);
    if (res.status !== "success" || res.x402?.status_code >= 300) throw new Error(`kpass failed: ${res.error_code ?? res.x402?.status_code} ${res.hint ?? ""}`);
    const rawAmt = String(res.payment_requirement?.amount ?? res.x402?.payment_requirement?.amount ?? "");
    const amountAtomic = /^\d+$/.test(rawAmt) && rawAmt.length > 3 ? rawAmt : String(Math.round(Number(rawAmt || l.total * 0.01) * 1e6));
    console.log(`  paid via ${res.x402?.wallet_address} amount ${rawAmt} → ${amountAtomic} atomic`);
    const tx = await findArcTx(res.x402.wallet_address, amountAtomic, since);
    rec = { tx, payer: res.x402.wallet_address, network: ARC.network, via: "kite-passport-dev", order: res.x402.parsed_response_body?.order?.id };
  } else {
    const r = await payWithKey(url);
    if (r.status >= 300) throw new Error(`payment failed with HTTP ${r.status}`);
    rec = { tx: r.tx, payer: r.payer, network: r.network, via: via === "arc-key" ? "demo-buyer-wallet-arc" : "demo-buyer-key", order: r.body?.order?.id };
    if (via === "arc-key" && rec.tx) {
      const rc = await createPublicClient({ chain: arcTestnet, transport: http() }).waitForTransactionReceipt({ hash: rec.tx });
      if (rc.status !== "success") throw new Error(`tx ${rec.tx} reverted`);
      console.log(`  on-chain: block ${rc.blockNumber}, status ${rc.status}`);
    }
  }
  if (!rec.tx) {
    console.log("  paid, but tx hash not found yet — check the explorer and add it by hand.");
    continue;
  }
  store.bySku[l.sku] = { ...rec, totalUsd: l.total, at: new Date().toISOString() };
  writeFileSync(receiptsPath, JSON.stringify(store, null, 1) + "\n");
  console.log(`  settled ${rec.tx} on ${rec.network}`);
}
console.log("\nDone. Commit src/data/live-receipts.json and redeploy to show the receipts.");
