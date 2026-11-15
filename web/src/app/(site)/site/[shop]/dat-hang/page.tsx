import type { Metadata } from "next";
import { notFound } from "next/navigation";
import OrderClient from "@/components/site/OrderClient";
import { getCatalog, getSite, siteBase } from "@/utils/siteServer";

export const metadata: Metadata = { title: "Đặt online", robots: { index: false } };

export default async function OrderPage({ params }: { params: Promise<{ shop: string }> }) {
  const { shop } = await params;
  const r = await getSite(shop);
  if (!r || !("site" in r)) notFound();
  const [catalog, base] = await Promise.all([getCatalog(shop), siteBase(shop)]);
  return <OrderClient site={r.site} catalog={catalog} base={base} />;
}
