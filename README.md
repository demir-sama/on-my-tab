<p align="center"><img src="public/brand/on-my-tab-logo.svg" width="140" alt="On My Tab logo: a receipt with a red cap line and a check stamp"></p>

# On My Tab

**An agent that buys it for you — inside a tab you seal.**

You say what you want ("a birthday gift for my sister, she loves plants") and seal a spending cap. On My Tab asks every shop for its live price the x402 way, has **SERV Reasoning** plan a cart, then pays what fits. If the next item would go over the tab it stops and asks you (**HOLD — OVER TAB**). If a seller is gouging, it refuses (**REFUSED — BAD DEAL**), even if the model wanted to buy. The rest of the order still lands, with receipts.

Built for **SERV Hackathon 02 · Kite track** (agents with a verifiable identity and spending limits you control). New project.

- **Live demo:** https://on-my-tab-five.vercel.app (no login; runs end to end for anyone)
- **Source:** https://github.com/demir-sama/on-my-tab
- **Demo video:** a 45 s, 1080p screen-capture walkthrough of the gift run (attached to the submission; not stored in this repo).

---

## How it works

```
 want + sealed cap
        │
        ▼
 1. PREFLIGHT  unpaid GET to each demo seller → HTTP 402 + Payment-Required (x402 v2, scheme "exact")
        │      price read from the seller's challenge, not from our catalog
        ▼
 2. SERV       SERV Reasoning (OpenAI-compatible chat/completions, required system prompt,
        │      strict json_schema) returns: order to try items, buy/skip, one-line reason each
        ▼
 3. THE TAB    deterministic guard (src/lib/engine.ts) has the last word:
        │        price > 1.5× going rate / cheapest substitute → REFUSED (even if SERV said buy)
        │        would exceed the sealed cap                    → HOLD, ask the user (raise or skip)
        │        unknown SKU / duplicate                        → dropped
        ▼
 4. PAY        each PAID line pays its seller's 402 (Kite Passport session or demo buyer key, testnet)
               receipts link to the explorer when a real settlement exists, else marked SEEDED
```

### How SERV is used
- Endpoint `https://inference-api.openserv.ai/v1/chat/completions`, model `gpt-5.4-mini` (env `SERV_MODEL`), **system prompt on every call**, `response_format: json_schema` (strict) with the SKU list as an enum, so SERV can only name items that were actually quoted.
- SERV gets the want, the cap and every live quote (unit price, qty, going rate, item description) and decides order + buy/skip with an auditable reason, plus a short note for the order (gift card line).
- The want is treated as data (prompt says so) and SERV's output is validated and normalised (`normalisePlan`), then **enforced by code**. The model proposes; the tab disposes.
- Credit is tiny, so: the two preset briefs replay **recorded real SERV responses** (`src/data/serv-recorded.json`, model id, token usage, latency and timestamp shown in the UI); custom wants call SERV live, rate-limited per IP and per instance and cached; if SERV is unavailable the UI says so and a clearly labelled rule-based planner runs instead.

### Kite / x402 integration
- Seller endpoints `GET /api/shops/:shop/v1/buy/:sku?qty=n` are adapted from **[BrKDDD/kite-x402-hono](https://github.com/BrKDDD/kite-x402-hono)** (Hono + `@x402/hono` 2.29, x402 v2, scheme `exact`, lazy facilitator init, fail-closed 503 when the facilitator or payTo is missing).
- **Rail 1 — Kite testnet** `eip155:2368`, pieUSD `0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A` (18 dp), facilitator `https://facilitator.pieverse.io/v2`. Always on.
- **Rail 2 — Arc testnet** `eip155:5042002`, Circle USDC `0x3600…0000` (6 dp, EIP-3009 verified on chain). This is the only chain the **Kite Passport dev (testnet) environment** pays on, and Pieverse doesn't list it, so the app runs an **in-process x402 facilitator** (`src/lib/arc-facilitator.ts`, `@x402/evm` exact facilitator) with a throwaway testnet relayer that pays gas. On in the live deploy (`ARC_RAIL=on`).
- Discovery: `GET /api/shops` (catalog) and `GET /api/shops/.well-known/x402`.
- Testnet settles at a demo scale (`SETTLE_SCALE`, default 0.01 → a $16 item settles 0.16 test units), shown on every receipt.
- **The tab is the Passport session.** For a real run, the sealed cap becomes the Passport session's `max_total_amount` and the priciest item its `max_amount_per_tx`, approved with the owner's passkey. Passport enforces the same line on the payment side that the app enforces on the planning side.

### Honest note: the live receipts are paid by a demo buyer wallet, not Passport
Kite's dev (testnet) Passport only executes payments to hosts in its curated service catalog (`ksearch service list`). We built the full Passport flow: `kpass` login, agent registration, and a separate session (\$0.50 total, \$0.20 per payment, 2 h, scoped to `/api/shops/`), which the owner **approved with a passkey**. On execute, Passport refused our host before signing anything: `host_not_in_executable_catalog` ("ask Kite to approve the host or whitelist your account for partner testing"). Nothing was spent from the session.

So the live gift run's receipts were paid by a **throwaway demo buyer wallet on Arc testnet** (`0x3c7E…3A48`) through the same 402 challenges and our self-hosted Arc facilitator. Each receipt says "paid by demo buyer wallet (Arc testnet), not Passport". Once Kite lists the host, `node scripts/pay.mjs --via passport` runs the same tab through Passport unchanged.

Gift run, Arc testnet USDC at 1:100 scale (seller `0x13A2…9f66`), 0.465 USDC total:

| Item | Paid | Tx |
|---|---|---|
| Golden pothos (\$16) | 0.16 | [0x6881…4c00](https://explorer.testnet.arc.io/tx/0x68813f6798566771f8d7c4d38a9d24e1306ede1c7bc06ac2dc5ba8dd107c4c00) |
| Linen journal (\$12) | 0.12 | [0x2242…ecca](https://explorer.testnet.arc.io/tx/0x2242fdbad1a9e9f70e517027fca0699a1e6619c35ec75a1eac74ecfe5c80ecca) |
| Card + wrap (\$4) | 0.04 | [0xacee…edb9](https://explorer.testnet.arc.io/tx/0xacee0d0a64994a8193be1a90949b6e947ae28b4e00bf63cde46e956fb056edb9) |
| Pressed bookmark (\$5) | 0.05 | [0x2c9a…cc04](https://explorer.testnet.arc.io/tx/0x2c9a126d89ae673dac642176dadd0666a4f2a9ce6cdbd7fbd446a1a649d4cc04) |
| Same-day courier (\$9.50, tab raised) | 0.095 | [0xa240…a7d](https://explorer.testnet.arc.io/tx/0xa240c7e2dd830567d7e4c26b6dc0b2c4118ea949b4db68113b9032fe8ad71a7d) |

The gilded journal (2.8× the going rate) was refused and never paid. The night-out run's receipts stay `SEEDED`.

### What's real vs seeded
| Real | Seeded |
|---|---|
| HTTP 402 challenges from our seller endpoints; Pieverse facilitator handshake | Shops, items, going rates (our own demo sellers, honestly labelled; nothing ships) |
| SERV Reasoning plans (live for custom wants; recorded real responses for presets) | Receipt refs marked `SEEDED-…` where no on-chain settlement was recorded |
| Cap + bad-deal guards, hold/raise/skip flow | |
| Arc testnet USDC settlements for the gift run (linked to the explorer), paid by a demo buyer wallet, not Passport | Night-out run receipts |

No mainnet config exists anywhere in this repo.

---

## Run it

```bash
npm install
cp .env.example .env    # fill in; chmod 600 .env
npm run dev             # http://localhost:3000
npm test                # vitest: engine (cap, bad deal, holds, hostile plans) + seller 402 behaviour
```

`.env` keys: `SERV_API_KEY` (server only), `SERV_MODEL`, `PAY_TO` (testnet seller address), `KITE_NETWORK=testnet`, `FACILITATOR_URL`, `SETTLE_SCALE`, `SERV_LIVE_LIMIT`, `ARC_RAIL`, `ARC_RELAYER_KEY` (throwaway Arc testnet relayer; never a real wallet), `ARC_BUYER_KEY` (throwaway Arc testnet demo buyer, used only by `scripts/pay.mjs`, never deployed), `ARC_RPC_URL` (optional).

### Real testnet payments

**A. Kite Passport (dev / testnet, Arc USDC)**
```bash
export KITE_PASSPORT_BASE_URL=https://passport.dev.gokite.ai
kpass login                                   # browser sign-in
kpass agent:register --type on-my-tab --output json
# the tab becomes the session: cap 0.50 total at 0.01 scale, max 0.20 per payment, 2h
kpass session create --separate --output json --delegation '{
  "task": {"summary": "On My Tab: buy a birthday gift bundle from On My Tab demo sellers, inside a sealed $40 tab."},
  "payment_policy": {"max_amount_per_tx": "0.20", "max_total_amount": "0.50", "ttl_seconds": 7200},
  "execution_constraints": {"x402": {"scope_mode": "scoped", "allowed_endpoints": [{"method": "GET", "host": "<app host>", "path_prefix": "/api/shops/"}]}}
}'
# owner approves the URL with their passkey, then:
node scripts/pay.mjs --base https://<app host> --brief gift --via passport --raise
# today this stops with host_not_in_executable_catalog (see the honest note above)
```

**A2. Demo buyer wallet (Arc testnet, USDC), what the live receipts use.** Put a throwaway `ARC_BUYER_KEY` in `.env`, fund it with test USDC, then
`node scripts/pay.mjs --base https://<app host> --brief gift --via arc-key --raise`.

**B. Demo buyer key (Kite testnet, pieUSD)** — fund the throwaway buyer address with test pieUSD, then
`node scripts/pay.mjs --base https://<app host> --brief night --via key`.

Both write tx hashes to `src/data/live-receipts.json`; redeploy and the receipts link to the explorer.

## Security notes
- SERV key and relayer key are server-side env only; never sent to the browser; never logged (error text is scrubbed).
- Request bodies validated with zod (want 3–240 chars, cap $1–$500); live SERV calls rate-limited.
- Seller rejects unknown items, mismatched shops and bad quantities before any payment logic; fails closed if the facilitator or `PAY_TO` is missing; malformed payment headers never settle (tests).
- Model output can't spend: SKU enum in the schema, `normalisePlan` drops unknown/duplicate SKUs, and the cap/bad-deal guard runs after SERV.

## Credits
Seller pattern and Kite network constants from BrKDDD/kite-x402-hono (Apache-2.0), which follows gokite-ai/kite-x402-services. x402 SDK by Coinbase. SERV Reasoning by OpenServ.
