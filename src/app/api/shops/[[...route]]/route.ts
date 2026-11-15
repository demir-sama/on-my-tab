import { sellerApp } from "@/lib/seller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = (req: Request) => sellerApp().fetch(req);
export const GET = handler;
export const OPTIONS = handler;
