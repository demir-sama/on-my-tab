"use client";

import { AnimatePresence, motion, useSpring, useTransform } from "motion/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { money, resolveHold, type Line, type Plan, type Quote, type TabResult } from "@/lib/engine";

interface BriefLite { id: string; label: string; want: string; cap: number }
interface RailLite { label: string; network: string; symbol: string }
interface Receipt { sku: string; mode: "testnet" | "seeded"; ref: string; url?: string; at?: string; network?: string; via?: string; payerLabel?: string }
interface RunResponse {
  want: string;
  cap: number;
  quotes: Quote[];
  plan: Plan;
  planSource: "serv-live" | "serv-recorded" | "serv-cached" | "fallback";
  meta: { model: string; latencyMs: number; usage?: { total_tokens?: number }; recordedAt?: string } | null;
  servError: string | null;
  result: TabResult;
  receipts: Receipt[];
  network: { network: string; symbol: string; settleScale: number; payTo: string | null };
}

type Phase = "idle" | "quoting" | "reasoning" | "printing" | "holding" | "done" | "error";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (s: string) => (s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s);

export default function TabApp(props: {
  briefs: BriefLite[];
  shopCount: number;
  productCount: number;
  rails: RailLite[];
  payTo: string | null;
  settleScale: number;
  liveReceipts: number;
}) {
  const [briefId, setBriefId] = useState<string>(props.briefs[0]!.id);
  const [want, setWant] = useState(props.briefs[0]!.want);
  const [cap, setCap] = useState(props.briefs[0]!.cap);
  const [phase, setPhase] = useState<Phase>("idle");
  const [run, setRun] = useState<RunResponse | null>(null);
  const [view, setView] = useState<TabResult | null>(null);
  const [shown, setShown] = useState(0);
  const [quotesShown, setQuotesShown] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const receiptRef = useRef<HTMLDivElement>(null);
  const deskRef = useRef<HTMLDivElement>(null);
  const busy = phase !== "idle" && phase !== "done" && phase !== "error";

  const pickBrief = (b: BriefLite | null) => {
    if (busy) return;
    if (!b) {
      setBriefId("custom");
      setWant("");
      return;
    }
    setBriefId(b.id);
    setWant(b.want);
    setCap(b.cap);
  };

  const seal = useCallback(async () => {
    if (busy || want.trim().length < 3) return;
    setError(null);
    setRun(null);
    setView(null);
    setShown(0);
    setQuotesShown(0);
    setPhase("quoting");
    if (window.matchMedia("(max-width: 900px)").matches) deskRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    try {
      const started = Date.now();
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ want: want.trim(), cap }),
      });
      const data = (await res.json()) as RunResponse & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
      await sleep(Math.max(0, 900 - (Date.now() - started)));
      setRun(data);
      for (let i = 1; i <= data.quotes.length; i++) {
        setQuotesShown(i);
        await sleep(230);
      }
      await sleep(500);
      setPhase("reasoning");
      await sleep(1900);
      setView(data.result);
      setPhase("printing");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setPhase("error");
    }
  }, [busy, want, cap]);

  // Print the receipt one line at a time; stop at a HOLD until the user answers.
  useEffect(() => {
    if (phase !== "printing" || !view) return;
    const current = view.lines[shown - 1];
    if (current?.verdict === "HOLD") {
      const t = setTimeout(() => setPhase("holding"), 650);
      return () => clearTimeout(t);
    }
    if (shown >= view.lines.length) {
      const t = setTimeout(() => setPhase("done"), 400);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setShown((n) => n + 1), shown === 0 ? 250 : 820);
    return () => clearTimeout(t);
  }, [phase, view, shown]);

  useEffect(() => {
    if (shown > 0) receiptRef.current?.querySelector(".r-line:last-of-type")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [shown]);

  const answerHold = (sku: string, action: "raise" | "skip") => {
    if (!view) return;
    setView(resolveHold(view, sku, action));
    setPhase("printing");
    setShown((n) => Math.min(n + 1, view.lines.length));
  };

  const visible = useMemo(() => (view ? view.lines.slice(0, shown) : []), [view, shown]);
  const spent = visible.filter((l) => l.verdict === "PAID").reduce((s, l) => s + l.total, 0);
  const tabCap = view?.cap ?? cap;
  const receipts = useMemo(() => new Map((run?.receipts ?? []).map((r) => [r.sku, r])), [run]);
  const holdLine = phase === "holding" ? visible[visible.length - 1] : undefined;
  const counts = useMemo(() => {
    const c = { PAID: 0, HOLD: 0, REFUSED: 0, SKIPPED: 0 };
    for (const l of visible) c[l.verdict]++;
    return c;
  }, [visible]);

  const reset = () => {
    setPhase("idle");
    setRun(null);
    setView(null);
    setShown(0);
    setQuotesShown(0);
  };

  return (
    <main className="shell">
      <div className="grain" aria-hidden />
      <header className="top">
        <Link className="mark" href="/" aria-label="On My Tab home">
          <TabGlyph />
          <span>On My Tab</span>
        </Link>
        <nav className="chips" aria-label="What powers it">
          <span className="chip">SERV Reasoning</span>
          <span className="chip">x402 · {props.rails.map((r) => r.symbol).join(" / ")}</span>
          <span className="chip chip--warn">Testnet · demo sellers</span>
        </nav>
      </header>

      <section className="stage">
        <div className="composer">
          <p className="eyebrow">An agent that buys it for you</p>
          <h1>
            Say what you want.
            <br />
            <em>Seal the tab.</em>
          </h1>
          <p className="lede">
            It checks every shop&apos;s live price, fits a cart under your cap, refuses bad deals, and asks before it would spend a cent you didn&apos;t
            approve.
          </p>

          <div className="briefs" role="tablist" aria-label="Example wants">
            {props.briefs.map((b) => (
              <button key={b.id} role="tab" aria-selected={briefId === b.id} className="brief-chip" onClick={() => pickBrief(b)} disabled={busy}>
                {b.label}
              </button>
            ))}
            <button role="tab" aria-selected={briefId === "custom"} className="brief-chip" onClick={() => pickBrief(null)} disabled={busy}>
              Write my own
            </button>
          </div>

          <label className="want">
            <span className="label">I want…</span>
            <textarea
              value={want}
              maxLength={240}
              rows={3}
              disabled={busy}
              placeholder="e.g. a birthday gift for my sister, she loves plants"
              onChange={(e) => {
                setWant(e.target.value);
                setBriefId("custom");
              }}
            />
          </label>

          <div className="capbox">
            <span className="label">The tab</span>
            <div className="cap-row">
              <button className="nudge" aria-label="Lower the cap by $5" disabled={busy || cap <= 5} onClick={() => setCap((c) => Math.max(5, c - 5))}>
                −
              </button>
              <div className="cap-value" aria-live="polite">
                <span className="cur">$</span>
                <AnimatedNumber value={cap} />
              </div>
              <button className="nudge" aria-label="Raise the cap by $5" disabled={busy || cap >= 500} onClick={() => setCap((c) => Math.min(500, c + 5))}>
                +
              </button>
            </div>
            <div className="cap-quick">
              {[20, 40, 60, 100].map((v) => (
                <button key={v} disabled={busy} aria-pressed={cap === v} onClick={() => setCap(v)}>
                  ${v}
                </button>
              ))}
            </div>
          </div>

          <motion.button className="seal" onClick={phase === "done" || phase === "error" ? reset : seal} disabled={busy || want.trim().length < 3} whileTap={{ scale: 0.97 }}>
            <span className="seal-wax" aria-hidden>
              <TabGlyph small />
            </span>
            <span>{phase === "done" || phase === "error" ? "Open a new tab" : busy ? "Tab sealed — shopping…" : `Seal a ${money(cap)} tab`}</span>
          </motion.button>
          <p className="fineprint">
            Shops here are our own demo sellers on testnet. No real goods ship and no real money moves.
          </p>
        </div>

        <div className="desk" ref={deskRef}>
          <TabMeter cap={tabCap} spent={spent} sealed={phase !== "idle"} raised={view ? view.cap > cap : false} />

          <Ticker phase={phase} run={run} quotesShown={quotesShown} />

          <AnimatePresence mode="popLayout">
            {phase === "idle" && (
              <motion.div key="empty" className="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, y: -8 }}>
                <ReceiptGhost />
                <p>
                  Your receipt prints here. {props.shopCount} demo shops, {props.productCount} items, one sealed tab.
                </p>
              </motion.div>
            )}
          </AnimatePresence>

          {run && (phase === "quoting" || phase === "reasoning") && <ShopBoard quotes={run.quotes} shown={quotesShown} />}

          {run && phase === "reasoning" && <Reasoning run={run} />}

          {view && (phase === "printing" || phase === "holding" || phase === "done") && (
            <motion.div className="receipt" ref={receiptRef} initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ type: "spring", stiffness: 140, damping: 18 }}>
              <div className="r-head">
                <TabGlyph small />
                <div>
                  <strong>ON MY TAB</strong>
                  <span>{new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
                </div>
                <span className="r-src">{sourceLabel(run!)}</span>
              </div>
              <p className="r-want">“{run!.want}”</p>
              <div className="r-rule" />
              <AnimatePresence initial={false}>
                {visible.map((l) => (
                  <ReceiptLine key={l.sku} line={l} receipt={receipts.get(l.sku)} onHold={answerHold} holding={holdLine?.sku === l.sku} preview={view} />
                ))}
              </AnimatePresence>
              {phase === "done" && (
                <motion.div className="r-foot" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.15 }}>
                  <div className="r-rule" />
                  <Row k={`PAID ×${counts.PAID}`} v={money(view.spent)} strong />
                  <Row k="TAB SEALED" v={money(view.cap)} />
                  <Row k="LEFT ON TAB" v={money(view.left)} />
                  <Row k="REFUSED" v={`${counts.REFUSED}`} />
                  {run!.plan.note && <p className="r-note">{run!.plan.note}</p>}
                  <div className="r-rule" />
                  <p className="r-small">
                    Prices read from each seller&apos;s HTTP 402 challenge (x402 v2, exact; {props.rails.map((r) => `${r.symbol} on ${r.label}`).join(" or ")}). Testnet settles at{" "}
                    {run!.network.settleScale === 1 ? "full value" : `1:${Math.round(1 / run!.network.settleScale)} scale`}.
                  </p>
                  <Barcode seed={run!.want + view.spent} />
                </motion.div>
              )}
            </motion.div>
          )}

          {phase === "error" && <div className="error">{error}</div>}
        </div>
      </section>

      <HowItWorks rails={props.rails} payTo={props.payTo} liveReceipts={props.liveReceipts} />

      <footer className="foot">
        <span>On My Tab · built for SERV Hackathon 02, Kite track</span>
        <span>
          Demo sellers · <Link href="/api/shops" prefetch={false}>catalog</Link> · <Link href="/api/shops/.well-known/x402" prefetch={false}>/.well-known/x402</Link> · <a href="https://github.com/demir-sama/on-my-tab" target="_blank" rel="noreferrer">source</a>
        </span>
      </footer>
    </main>
  );
}

function sourceLabel(run: RunResponse) {
  switch (run.planSource) {
    case "serv-live":
      return "SERV · live";
    case "serv-recorded":
      return "SERV · recorded";
    case "serv-cached":
      return "SERV · cached";
    default:
      return "Rule-based fallback";
  }
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className={`r-row${strong ? " r-row--strong" : ""}`}>
      <span>{k}</span>
      <span className="r-dots" />
      <span>{v}</span>
    </div>
  );
}

function ReceiptLine({
  line,
  receipt,
  onHold,
  holding,
  preview,
}: {
  line: Line;
  receipt?: Receipt;
  onHold: (sku: string, a: "raise" | "skip") => void;
  holding: boolean;
  preview: TabResult;
}) {
  const raiseBy = holding ? (() => {
    try {
      const next = resolveHold(preview, line.sku, "raise");
      return next.cap - preview.cap;
    } catch {
      return line.overBy ?? 0;
    }
  })() : 0;
  return (
    <motion.div
      className={`r-line r-line--${line.verdict.toLowerCase()}`}
      layout
      initial={{ opacity: 0, clipPath: "inset(0 0 100% 0)" }}
      animate={{ opacity: 1, clipPath: "inset(0 0 0% 0)" }}
      transition={{ duration: 0.45, ease: [0.2, 0.8, 0.2, 1] }}
    >
      <div className="r-row">
        <span className="r-title">
          {line.qty > 1 && <b>{line.qty}× </b>}
          {line.title}
        </span>
        <span className="r-dots" />
        <span className="r-amt">{money(line.total)}</span>
      </div>
      <div className="r-meta">
        {line.shopName} · going rate {money(line.reference)}
        {line.markup >= 1.2 && <span className="r-markup"> · {line.markup}×</span>}
      </div>
      {line.servReason && (
        <div className="r-serv">
          <span>SERV</span> {line.servReason}
        </div>
      )}
      <div className="r-guard">{line.guard}</div>
      <Stamp verdict={line.verdict} markup={line.markup} />
      {line.verdict === "PAID" && receipt && (
        <div className="r-receipt">
          {receipt.mode === "testnet" && receipt.url ? (
            <a href={receipt.url} target="_blank" rel="noreferrer">
              {receipt.network ?? "testnet"} tx {short(receipt.ref)} ↗
            </a>
          ) : null}
          {receipt.mode === "testnet" && receipt.url ? (
            <span className="r-payer"> · paid by {receipt.payerLabel ?? "demo buyer wallet, not Passport"}</span>
          ) : (
            <span title="Seeded receipt: no on-chain settlement for this run">{receipt.ref} · seeded</span>
          )}
        </div>
      )}
      <AnimatePresence>
        {holding && (
          <motion.div className="hold-ask" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
            <p>
              This would put your tab <strong>{money(line.overBy ?? raiseBy)}</strong> over. Your call.
            </p>
            <div className="hold-btns">
              <button className="btn-raise" onClick={() => onHold(line.sku, "raise")}>
                Raise tab +{money(raiseBy)}
              </button>
              <button className="btn-skip" onClick={() => onHold(line.sku, "skip")}>
                Skip it
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function Stamp({ verdict, markup }: { verdict: Line["verdict"]; markup: number }) {
  const text =
    verdict === "PAID" ? ["PAID", "on tab"] : verdict === "HOLD" ? ["HOLD", "over tab"] : verdict === "REFUSED" ? ["REFUSED", `bad deal · ${markup}×`] : ["SKIPPED", ""];
  const rot = verdict === "REFUSED" ? -9 : verdict === "HOLD" ? 6 : -3;
  return (
    <motion.div
      className={`stamp stamp--${verdict.toLowerCase()}`}
      initial={{ scale: 2.6, opacity: 0, rotate: rot * 2.5 }}
      animate={{ scale: 1, opacity: 1, rotate: rot }}
      transition={{ type: "spring", stiffness: 520, damping: 22, delay: 0.28 }}
      aria-label={`${text[0]} ${text[1]}`}
    >
      <span className="stamp-main">{text[0]}</span>
      {text[1] && <span className="stamp-sub">{text[1]}</span>}
    </motion.div>
  );
}

function TabMeter({ cap, spent, sealed, raised }: { cap: number; spent: number; sealed: boolean; raised: boolean }) {
  const pct = Math.min(1, cap > 0 ? spent / cap : 0);
  const spring = useSpring(0, { stiffness: 90, damping: 18 });
  useEffect(() => spring.set(pct), [pct, spring]);
  const width = useTransform(spring, (v) => `${(v * 100).toFixed(2)}%`);
  return (
    <div className={`meter${sealed ? " meter--sealed" : ""}`}>
      <div className="meter-top">
        <div>
          <span className="label">Tab {sealed ? "sealed" : "ready"}</span>
          <strong>
            <AnimatedNumber value={cap} prefix="$" decimals={2} />
          </strong>
          {raised && <span className="raised">raised by you</span>}
        </div>
        <div className="meter-left">
          <span className="label">Left</span>
          <strong>
            <AnimatedNumber value={Math.max(0, cap - spent)} prefix="$" decimals={2} />
          </strong>
        </div>
      </div>
      <div className="meter-track" role="meter" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={spent} aria-label="Tab spent">
        <motion.div className="meter-fill" style={{ width }} />
        <div className="meter-ticks" aria-hidden>
          {Array.from({ length: 20 }).map((_, i) => (
            <i key={i} />
          ))}
        </div>
      </div>
      <div className="meter-foot">
        <span>
          Spent <AnimatedNumber value={spent} prefix="$" decimals={2} />
        </span>
        <span>{sealed ? "Agent can't go past this line without asking you." : "Nothing spends until you seal it."}</span>
      </div>
    </div>
  );
}

function Ticker({ phase, run, quotesShown }: { phase: Phase; run: RunResponse | null; quotesShown: number }) {
  const steps = [
    { id: "quoting", label: run ? `Read ${quotesShown}/${run.quotes.length} prices from 402 challenges` : "Asking each shop for its price (HTTP 402)" },
    { id: "reasoning", label: "SERV reasons over the quotes" },
    { id: "printing", label: "Paying what fits · holding · refusing" },
  ];
  const order = ["quoting", "reasoning", "printing", "done"];
  const idx = phase === "holding" ? 2 : order.indexOf(phase);
  if (phase === "idle" || phase === "error") return null;
  return (
    <ol className="ticker">
      {steps.map((s, i) => (
        <li key={s.id} className={i < idx || phase === "done" ? "is-done" : i === idx ? "is-now" : ""}>
          <span className="tick-dot" />
          {phase === "holding" && i === 2 ? "Waiting on you — over-tab item" : s.label}
        </li>
      ))}
    </ol>
  );
}

function ShopBoard({ quotes, shown }: { quotes: Quote[]; shown: number }) {
  return (
    <div className="board">
      {quotes.map((q, i) => (
        <motion.div
          key={q.sku}
          className="board-row"
          initial={{ opacity: 0.25 }}
          animate={{ opacity: i < shown ? 1 : 0.25 }}
        >
          <span className="board-shop">{q.shopName}</span>
          <span className="board-item">{q.title}</span>
          <span className="board-code">{i < shown ? (q.source === "x402" ? "402" : "cat") : "···"}</span>
          <span className="board-price">{i < shown ? money(q.total) : "—"}</span>
        </motion.div>
      ))}
    </div>
  );
}

function Reasoning({ run }: { run: RunResponse }) {
  const m = run.meta;
  return (
    <motion.div className="reasoning" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
      <div className="reasoning-head">
        <span className="pulse" />
        {run.planSource === "fallback" ? "Rule-based planner (SERV unavailable)" : "SERV Reasoning"}
        {m && (
          <span className="reasoning-meta">
            {m.model} · {m.usage?.total_tokens ?? "?"} tokens · {(m.latencyMs / 1000).toFixed(1)}s
          </span>
        )}
      </div>
      <p>{run.plan.summary}</p>
      {run.servError && <p className="reasoning-warn">{run.servError}</p>}
    </motion.div>
  );
}

function HowItWorks({ rails, payTo, liveReceipts }: { rails: RailLite[]; payTo: string | null; liveReceipts: number }) {
  return (
    <section className="how">
      <h2>
        How the tab <em>holds</em>
      </h2>
      <div className="how-grid">
        <article>
          <span className="how-n">01</span>
          <h3>Live prices, the x402 way</h3>
          <p>
            Each shop is a paid endpoint. An unpaid request gets <code>HTTP 402</code> with a Payment-Required challenge: x402 v2, exact scheme, on{" "}
            {rails.map((r) => r.label).join(" and ")}. The agent reads the price the seller actually demands, not a catalog guess.
          </p>
        </article>
        <article>
          <span className="how-n">02</span>
          <h3>SERV plans the cart</h3>
          <p>
            SERV Reasoning gets the want, the sealed cap and every quote, and returns a strict JSON plan: an order to try items in, buy or skip for each one,
            and a one-line reason you can audit.
          </p>
        </article>
        <article>
          <span className="how-n">03</span>
          <h3>The tab has the last word</h3>
          <p>
            Code, not the model, enforces the rules. Over the cap means <b>HOLD</b> and ask you. Over 1.5× the going rate means <b>REFUSED</b>, even if the
            model wanted it. Unknown items are dropped. Everything else pays.
          </p>
        </article>
      </div>
      <div className="truth">
        <h3>What&apos;s real here</h3>
        <ul>
          <li>
            <b>Real:</b> the 402 challenges from our seller endpoints (forked from kite-x402-hono), the Pieverse facilitator handshake, SERV&apos;s plans,
            the cap and bad-deal guards.
          </li>
          <li>
            <b>Real when marked with a tx link:</b> Arc testnet USDC settlements through our self-hosted x402 facilitator.{" "}
            {liveReceipts > 0 ? `${liveReceipts} item(s) have recorded on-chain receipts.` : "None recorded yet, so receipts show SEEDED."} The gift
            run&apos;s receipts were paid by a <b>demo buyer wallet</b>, not Kite Passport: Kite&apos;s dev Passport only pays hosts in its curated
            service catalog and refused ours (<code>host_not_in_executable_catalog</code>). The Passport session flow is built and was approved, but
            couldn&apos;t execute.
          </li>
          <li>
            <b>Seeded:</b> the shops, items and going rates. They&apos;re our own demo sellers, not real merchants, and nothing ships.
          </li>
          {payTo && (
            <li>
              Seller wallet (testnet): <code>{short(payTo)}</code>
            </li>
          )}
        </ul>
      </div>
    </section>
  );
}

function AnimatedNumber({ value, prefix = "", decimals = 0 }: { value: number; prefix?: string; decimals?: number }) {
  const spring = useSpring(value, { stiffness: 120, damping: 20 });
  const text = useTransform(spring, (v) => `${prefix}${v.toFixed(decimals)}`);
  useEffect(() => spring.set(value), [value, spring]);
  return <motion.span>{text}</motion.span>;
}

function TabGlyph({ small }: { small?: boolean }) {
  const s = small ? 18 : 26;
  return (
    <svg width={s} height={s} viewBox="0 0 64 64" aria-hidden>
      <path d="M14 8h36v48l-4.5-3.4L41 56l-4.5-3.4L32 56l-4.5-3.4L23 56l-4.5-3.4L14 56z" fill="currentColor" opacity="0.95" />
      <circle cx="32" cy="28" r="9.5" fill="var(--tab)" />
      <path d="M27.5 28.2l3.2 3.2 5.6-6.4" stroke="var(--paper)" strokeWidth="2.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ReceiptGhost() {
  return (
    <div className="ghost" aria-hidden>
      {[72, 54, 64, 40, 58].map((w, i) => (
        <i key={i} style={{ width: `${w}%`, animationDelay: `${i * 0.12}s` }} />
      ))}
    </div>
  );
}

function Barcode({ seed }: { seed: string }) {
  const bars = useMemo(() => {
    const out: number[] = [];
    for (let i = 0, h = 7; i < 46; i++) {
      h = (h * 31 + seed.charCodeAt(i % seed.length)) % 997;
      out.push(1 + (h % 3));
    }
    return out;
  }, [seed]);
  return (
    <div className="barcode" aria-hidden>
      {bars.map((w, i) => (
        <i key={i} style={{ width: w, opacity: i % 2 ? 0 : 1 }} />
      ))}
    </div>
  );
}
