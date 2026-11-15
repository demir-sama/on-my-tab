// Seeded demo catalog. Every shop here is OUR OWN x402 seller endpoint on Kite
// testnet, honestly labelled as a demo seller. None of these are real merchants.

export type ShopId =
  | "kiosk-nine"
  | "lantern-paper"
  | "gilded-paper"
  | "northside-box"
  | "gate-resale"
  | "ember-kitchen"
  | "glide-rides"
  | "dash-courier";

export interface Shop {
  id: ShopId;
  name: string;
  tagline: string;
  kind: "gifts" | "stationery" | "tickets" | "food" | "rides" | "courier";
}

export interface Product {
  sku: string;
  shop: ShopId;
  title: string;
  blurb: string;
  /** Price in display dollars (cents precision). The seller quotes this in its 402. */
  price: number;
  /** What the same thing usually costs elsewhere — the "going rate" anchor. */
  reference: number;
  /** Items sharing a group are substitutes (e.g. the same journal from two shops). */
  group: string;
  tags: string[];
  /** Nice-to-have extras are tried last. */
  extra?: boolean;
}

export const SHOPS: Record<ShopId, Shop> = {
  "kiosk-nine": { id: "kiosk-nine", name: "Kiosk Nine", tagline: "Plants & small gifts", kind: "gifts" },
  "lantern-paper": { id: "lantern-paper", name: "Lantern Paper", tagline: "Stationery, fairly priced", kind: "stationery" },
  "gilded-paper": { id: "gilded-paper", name: "Gilded Paper Co.", tagline: "Stationery, 'curated'", kind: "stationery" },
  "northside-box": { id: "northside-box", name: "Northside Box Office", tagline: "Official venue tickets", kind: "tickets" },
  "gate-resale": { id: "gate-resale", name: "GateSwap Resale", tagline: "Resale tickets", kind: "tickets" },
  "ember-kitchen": { id: "ember-kitchen", name: "Ember Kitchen", tagline: "Late-night grill", kind: "food" },
  "glide-rides": { id: "glide-rides", name: "Glide Rides", tagline: "Rides home", kind: "rides" },
  "dash-courier": { id: "dash-courier", name: "Dash Courier", tagline: "Same-day delivery", kind: "courier" },
};

export const PRODUCTS: Product[] = [
  // Gift brief
  { sku: "pothos-ceramic", shop: "kiosk-nine", title: "Golden pothos in speckled ceramic pot", blurb: "Hard to kill, looks great on a desk.", price: 16, reference: 17, group: "plant", tags: ["plant", "gift", "home", "sister", "birthday"] },
  { sku: "linen-journal", shop: "lantern-paper", title: "Linen dot-grid journal, A5", blurb: "Lay-flat binding, 160 pages.", price: 12, reference: 12.5, group: "journal", tags: ["journal", "writing", "gift", "stationery"] },
  { sku: "linen-journal-gilded", shop: "gilded-paper", title: "Linen dot-grid journal, A5 (same SKU)", blurb: "Identical journal, 'gift-ready' sticker.", price: 34, reference: 12.5, group: "journal", tags: ["journal", "writing", "gift", "stationery"] },
  { sku: "card-wrap", shop: "lantern-paper", title: "Hand-lettered card + kraft wrap", blurb: "Birthday card and recycled wrap.", price: 4, reference: 4.5, group: "card", tags: ["card", "wrap", "birthday", "gift"] },
  { sku: "pressed-bookmark", shop: "kiosk-nine", title: "Pressed-flower bookmark", blurb: "Small add-on for a journal lover.", price: 5, reference: 5, group: "bookmark", tags: ["bookmark", "gift", "journal"], extra: true },
  { sku: "same-day-courier", shop: "dash-courier", title: "Priority same-day courier", blurb: "Delivered to her door by 7pm.", price: 9.5, reference: 9, group: "delivery", tags: ["delivery", "courier", "gift"], extra: true },

  // Night-out brief
  { sku: "show-ticket-official", shop: "northside-box", title: "Saturday show — GA ticket (face value)", blurb: "Official box office, mobile ticket.", price: 14, reference: 14, group: "ticket", tags: ["ticket", "show", "concert", "night", "saturday"] },
  { sku: "show-ticket-resale", shop: "gate-resale", title: "Saturday show — GA ticket (resale)", blurb: "Same ticket, 'last few left'.", price: 38, reference: 14, group: "ticket", tags: ["ticket", "show", "concert", "night", "saturday"] },
  { sku: "suya-platter", shop: "ember-kitchen", title: "Suya platter for two", blurb: "Beef suya, yaji, onions, pepper sauce.", price: 18, reference: 19, group: "food", tags: ["food", "dinner", "eat", "night", "two"] },
  { sku: "ride-home", shop: "glide-rides", title: "Ride home for two", blurb: "Standard car, booked for 11:30pm.", price: 11, reference: 11, group: "ride", tags: ["ride", "home", "night", "car"] },
  { sku: "vip-lounge", shop: "northside-box", title: "Balcony seats upgrade (VIP, for two)", blurb: "Upgrades both tickets to balcony seats, one drink each.", price: 12, reference: 12, group: "vip", tags: ["vip", "upgrade", "show", "night"], extra: true },
];

export interface Brief {
  id: string;
  label: string;
  want: string;
  cap: number;
  /** Quantities per SKU when the brief needs more than one. */
  qty?: Record<string, number>;
  candidates: string[];
}

export const BRIEFS: Brief[] = [
  {
    id: "gift",
    label: "Birthday gift",
    want: "A birthday gift for my sister Ama. She loves plants and journaling. Wrap it nicely, and get it to her today if you can.",
    cap: 40,
    candidates: ["pothos-ceramic", "linen-journal", "linen-journal-gilded", "card-wrap", "pressed-bookmark", "same-day-courier"],
  },
  {
    id: "night",
    label: "Saturday night",
    want: "Two tickets to the Saturday show, something to eat after, and a ride home. Upgrade us to balcony seats if you can.",
    cap: 60,
    qty: { "show-ticket-official": 2, "show-ticket-resale": 2 },
    candidates: ["show-ticket-resale", "show-ticket-official", "suya-platter", "ride-home", "vip-lounge"],
  },
];

export function productBySku(sku: string): Product | undefined {
  return PRODUCTS.find((p) => p.sku === sku);
}

/** Pick candidate SKUs for a free-text want (deterministic; SERV reasons over these). */
export function candidatesForWant(want: string): { candidates: string[]; qty: Record<string, number> } {
  const text = want.toLowerCase();
  const preset = BRIEFS.find((b) => b.want.toLowerCase() === text.trim());
  if (preset) return { candidates: preset.candidates, qty: preset.qty ?? {} };
  const scored = BRIEFS.map((b) => {
    const tags = new Set(b.candidates.flatMap((s) => productBySku(s)?.tags ?? []));
    let score = 0;
    for (const t of tags) if (text.includes(t)) score++;
    return { b, score };
  }).sort((a, z) => z.score - a.score);
  const best = scored[0]!.b;
  const qty = { ...(best.qty ?? {}) };
  const two = /\b(two|2|both|pair|couple)\b/.test(text);
  if (best.id === "night" && !two) {
    for (const k of Object.keys(qty)) qty[k] = 1;
  }
  return { candidates: best.candidates, qty };
}
