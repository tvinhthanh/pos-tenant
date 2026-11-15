import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPosts, getSite, siteBase, siteOrigin } from "@/utils/siteServer";
import { fmtDateVN as fmtDate, href } from "@/utils/site";

const PER_PAGE = 12;
type Props = { params: Promise<{ shop: string }>; searchParams: Promise<{ trang?: string }> };

const pageOf = (v?: string) => Math.max(1, Math.min(500, Number.parseInt(v || "1", 10) || 1));

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { shop } = await params;
  const page = pageOf((await searchParams).trang);
  const r = await getSite(shop);
  if (!r || !("site" in r)) return {};
  const origin = await siteOrigin(r.site);
  const url = `${origin}/tin-tuc${page > 1 ? `?trang=${page}` : ""}`;
  return {
    title: "Tin tức",
    description: `Tin tức, ưu đãi mới nhất từ ${r.site.name}.`,
    alternates: { canonical: url },
    openGraph: { title: `Tin tức · ${r.site.name}`, url, siteName: r.site.name, locale: "vi_VN", type: "website" },
  };
}

export default async function PostsPage({ params, searchParams }: Props) {
  const { shop } = await params;
  const page = pageOf((await searchParams).trang);
  const r = await getSite(shop);
  if (!r || !("site" in r)) notFound();
  const [{ total, items }, base] = await Promise.all([getPosts(shop, PER_PAGE, (page - 1) * PER_PAGE), siteBase(shop)]);
  if (page > 1 && items.length === 0) notFound();
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Tin tức</h1>
      {items.length === 0 ? (
        <p className="mt-6 text-[var(--c-muted)]">Chưa có bài viết nào.</p>
      ) : (
        <ul className="mt-8 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((p) => (
            <li key={p.slug}>
              <a href={href(base, `/tin-tuc/${p.slug}`)} className="group block">
                {p.cover_image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.cover_image} alt="" loading="lazy"
                    className="aspect-[16/10] w-full rounded-[var(--radius)] bg-[var(--c-surface)] object-cover" />
                ) : (
                  <div className="aspect-[16/10] w-full rounded-[var(--radius)] bg-[var(--c-surface)]" aria-hidden="true" />
                )}
                <p className="mt-3 text-xs text-[var(--c-muted)]"><time dateTime={p.published_at}>{fmtDate(p.published_at)}</time></p>
                <h2 className="mt-1 text-lg font-semibold leading-snug group-hover:text-[var(--c-primary)]">{p.title}</h2>
                {p.excerpt && <p className="mt-1 line-clamp-3 text-sm text-[var(--c-muted)]">{p.excerpt}</p>}
              </a>
            </li>
          ))}
        </ul>
      )}
      {pages > 1 && (
        <nav className="mt-10 flex items-center justify-center gap-4 text-sm" aria-label="Phân trang">
          {page > 1 && <a href={href(base, `/tin-tuc${page > 2 ? `?trang=${page - 1}` : ""}`)} className="text-[var(--c-primary)] hover:underline">← Mới hơn</a>}
          <span className="text-[var(--c-muted)]">Trang {page}/{pages}</span>
          {page < pages && <a href={href(base, `/tin-tuc?trang=${page + 1}`)} className="text-[var(--c-primary)] hover:underline">Cũ hơn →</a>}
        </nav>
      )}
    </div>
  );
}
