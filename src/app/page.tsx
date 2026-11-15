import { BRIEFS, PRODUCTS, SHOPS } from "@/lib/catalog";
import { KITE_TESTNET, ARC_TESTNET, settleScale } from "@/lib/kite";
import { liveReceiptCount } from "@/lib/receipts";
import TabApp from "@/components/TabApp";

export const dynamic = "force-dynamic";

export default function Page() {
  const arcOn = process.env.ARC_RAIL === "on";
  return (
    <TabApp
      briefs={BRIEFS.map((b) => ({ id: b.id, label: b.label, want: b.want, cap: b.cap }))}
      shopCount={Object.keys(SHOPS).length}
      productCount={PRODUCTS.length}
      rails={[KITE_TESTNET, ...(arcOn ? [ARC_TESTNET] : [])].map((r) => ({ label: r.label, network: r.network, symbol: r.symbol }))}
      payTo={process.env.PAY_TO ?? null}
      settleScale={settleScale()}
      liveReceipts={liveReceiptCount()}
    />
  );
}
