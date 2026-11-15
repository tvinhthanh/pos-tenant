import type { Metadata } from "next";
import { notFound } from "next/navigation";
import AccountClient from "@/components/site/AccountClient";
import { getSite, siteBase } from "@/utils/siteServer";

export const metadata: Metadata = { title: "Tài khoản", robots: { index: false } };

export default async function AccountPage({ params }: { params: Promise<{ shop: string }> }) {
  const { shop } = await params;
  const r = await getSite(shop);
  if (!r || !("site" in r)) notFound();
  return <AccountClient site={r.site} base={await siteBase(shop)} />;
}
