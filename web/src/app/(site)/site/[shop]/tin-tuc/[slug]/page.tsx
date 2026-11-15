import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RichText } from "@/components/site/Sections";
import { getPost, getSite, siteBase, siteOrigin } from "@/utils/siteServer";
import { fmtDateVN, href, type PublicPost, type PublicSite } from "@/utils/site";

type Props = { params: Promise<{ shop: string; slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { shop, slug } = await params;
  const [r, post] = await Promise.all([getSite(shop), getPost(shop, decodeURIComponent(slug))]);
  if (!r || !("site" in r) || !post) return {};
  const origin = await siteOrigin(r.site);
  const url = `${origin}/tin-tuc/${post.slug}`;
  const description = post.excerpt || post.body.replace(/[*\n]+/g, " ").trim().slice(0, 160) || undefined;
  return {
    title: post.title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: post.title, description, url, siteName: r.site.name, locale: "vi_VN", type: "article",
      publishedTime: post.published_at, modifiedTime: post.updated_at,
      images: post.cover_image ? [post.cover_image] : r.site.logo_url ? [r.site.logo_url] : undefined,
    },
  };
}

// JSON-LD BlogPosting; "<" escape để dữ liệu không đóng được thẻ script
function jsonLd(site: PublicSite, post: PublicPost, url: string) {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.excerpt || undefined,
    image: post.cover_image || undefined,
    datePublished: post.published_at,
    dateModified: post.updated_at,
    mainEntityOfPage: url,
    publisher: { "@type": "Organization", name: site.name, logo: site.logo_url || undefined },
  }).replace(/</g, "\\u003c");
}

export default async function PostPage({ params }: Props) {
  const { shop, slug } = await params;
  const [r, post] = await Promise.all([getSite(shop), getPost(shop, decodeURIComponent(slug))]);
  if (!r || !("site" in r) || !post) notFound();
  const [base, origin] = await Promise.all([siteBase(shop), siteOrigin(r.site)]);

  return (
    <article className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(r.site, post, `${origin}/tin-tuc/${post.slug}`) }} />
      <a href={href(base, "/tin-tuc")} className="text-sm text-[var(--c-primary)] hover:underline">← Tin tức</a>
      <h1 className="mt-4 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">{post.title}</h1>
      <p className="mt-2 text-sm text-[var(--c-muted)]"><time dateTime={post.published_at}>{fmtDateVN(post.published_at)}</time></p>
      {post.cover_image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={post.cover_image} alt="" className="mt-8 w-full rounded-[var(--radius)] object-cover" />
      )}
      {post.excerpt && <p className="mt-8 text-lg text-[var(--c-muted)]">{post.excerpt}</p>}
      <RichText text={post.body} className="mt-6 text-base leading-relaxed" />
    </article>
  );
}
