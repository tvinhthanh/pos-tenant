import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SectionList } from "@/components/site/Sections";
import { getCatalog, getPage, getSite, siteBase, siteOrigin } from "@/utils/siteServer";
import { hoursByDay, type PublicSite } from "@/utils/site";

type Params = Promise<{ shop: string; path?: string[] }>;

const toPath = (segments?: string[]) => "/" + (segments ?? []).map((s) => decodeURIComponent(s)).join("/");

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { shop, path } = await params;
  const [r, page] = await Promise.all([getSite(shop), getPage(shop, toPath(path))]);
  if (!r || !("site" in r) || !page) return {};
  const site = r.site;
  const origin = await siteOrigin(site);
  const url = `${origin}${page.path === "/" ? "" : page.path}`;
  const title = page.seo?.title || (page.path === "/" ? site.name : page.title);
  const description = page.seo?.description || site.tagline || undefined;
  const image = page.seo?.og_image || site.logo_url || undefined;
  return {
    title: page.path === "/" ? { absolute: title } : title,
    description,
    alternates: { canonical: url },
    robots: page.seo?.noindex ? { index: false, follow: true } : undefined,
    openGraph: { title, description, url, siteName: site.name, locale: "vi_VN", type: "website", images: image ? [image] : undefined },
  };
}

// JSON-LD LocalBusiness theo nghiệp vụ: tên, địa chỉ, SĐT, giờ mở cửa
function jsonLd(site: PublicSite, url: string) {
  const days = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": site.business_type === "fnb" ? "Restaurant" : site.business_type === "retail" ? "Store" : "LocalBusiness",
    name: site.name,
    url,
    telephone: site.integrations?.hotline || site.phone || undefined,
    image: site.logo_url || undefined,
    address: site.address ? { "@type": "PostalAddress", streetAddress: site.address, addressCountry: "VN" } : undefined,
    openingHoursSpecification: hoursByDay(site.opening_hours || []).flatMap((d) =>
      (site.opening_hours || []).filter((h) => h.days.includes(d.day)).map((h) => ({
        "@type": "OpeningHoursSpecification", dayOfWeek: days[d.day], opens: h.open, closes: h.close,
      }))),
  };
  if (site.integrations?.map_lat && site.integrations?.map_lng) {
    data.geo = { "@type": "GeoCoordinates", latitude: Number(site.integrations.map_lat), longitude: Number(site.integrations.map_lng) };
  }
  // "<" escape để chuỗi dữ liệu không đóng được thẻ script
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export default async function SitePage({ params }: { params: Params }) {
  const { shop, path } = await params;
  const p = toPath(path);
  const [r, page] = await Promise.all([getSite(shop), getPage(shop, p)]);
  if (!r || !("site" in r) || !page) notFound();
  const site = r.site;

  const needsCatalog = page.sections.some((s) => s.visible !== false && ["catalog", "featured_items"].includes(s.type));
  const [catalog, base, origin] = await Promise.all([
    needsCatalog ? getCatalog(shop) : Promise.resolve([]),
    siteBase(shop),
    siteOrigin(site),
  ]);

  return (
    <>
      {page.path === "/" && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(site, origin) }} />
      )}
      {page.path !== "/" && !page.sections.some((s) => s.type === "hero") && (
        <div className="mx-auto max-w-6xl px-4 pt-12 sm:px-6">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{page.title}</h1>
        </div>
      )}
      <SectionList sections={page.sections} ctx={{ site, catalog, base }} />
    </>
  );
}
