/**
 * Khối của website shop. Component thuần (không hook, không API server) nên dùng
 * chung cho trang công khai (SSR) và khung xem trước của trình chỉnh sửa.
 * Văn bản chỉ là chữ thuần / markdown tối giản — không bao giờ render HTML từ dữ liệu.
 */
import React from "react";
import {
  contactLinks, hoursByDay, isOpenNow, mapEmbedUrl, mapLinkUrl, safeHref, vnd,
  DAY_LABELS, RATE_UNIT_LABELS, type CatalogItem, type Section, type SiteContext,
} from "@/utils/site";

// ---------------------------------------------------------------------------
// Markdown tối giản: **đậm**, *nghiêng*, dòng "- " thành danh sách, dòng trống tách đoạn
// ---------------------------------------------------------------------------
function inline(text: string, key: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    out.push(t.startsWith("**")
      ? <strong key={`${key}-${i++}`}>{t.slice(2, -2)}</strong>
      : <em key={`${key}-${i++}`}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function RichText({ text, className = "" }: { text?: string; className?: string }) {
  if (!text) return null;
  const blocks = text.replace(/\r/g, "").split(/\n{2,}/);
  return (
    <div className={`space-y-3 ${className}`}>
      {blocks.map((b, bi) => {
        const lines = b.split("\n");
        if (lines.every((l) => /^\s*[-•]\s+/.test(l))) {
          return (
            <ul key={bi} className="list-disc space-y-1 pl-5">
              {lines.map((l, li) => <li key={li}>{inline(l.replace(/^\s*[-•]\s+/, ""), `${bi}-${li}`)}</li>)}
            </ul>
          );
        }
        return (
          <p key={bi}>
            {lines.map((l, li) => (
              <React.Fragment key={li}>{li > 0 && <br />}{inline(l, `${bi}-${li}`)}</React.Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Khung chung
// ---------------------------------------------------------------------------
function Wrap({ children, tone = "bg", id }: { children: React.ReactNode; tone?: "bg" | "surface"; id?: string }) {
  return (
    <section id={id} className={tone === "surface" ? "bg-[var(--c-surface)]" : ""}>
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">{children}</div>
    </section>
  );
}

function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-8 text-2xl font-semibold tracking-tight sm:text-3xl">{children}</h2>;
}

const btn = "inline-flex items-center justify-center rounded-[var(--radius)] px-6 py-3 text-sm font-semibold transition hover:opacity-90";

function Placeholder({ label }: { label: string }) {
  return <div className="flex h-full min-h-[120px] w-full items-center justify-center bg-[var(--c-surface)] text-xs text-[var(--c-muted)]">{label}</div>;
}

// ---------------------------------------------------------------------------
// Từng loại khối
// ---------------------------------------------------------------------------
function Hero({ p, ctx }: { p: any; ctx: SiteContext }) {
  const link = safeHref(ctx.base, p.cta_href);
  const img = safeHref("", p.image);
  const open = isOpenNow(ctx.site.opening_hours);
  return (
    <section className="relative overflow-hidden">
      {img && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={img} alt="" className="absolute inset-0 h-full w-full object-cover" />
      )}
      <div className={img ? "absolute inset-0 bg-black/45" : "absolute inset-0 bg-[var(--c-surface)]"} />
      <div className={`relative mx-auto max-w-6xl px-4 py-24 sm:px-6 sm:py-32 ${img ? "text-white" : ""}`}>
        {open !== null && (
          <p className={`mb-5 inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${img ? "bg-white/15" : "bg-[var(--c-bg)]"}`}>
            <span className={`h-2 w-2 rounded-full ${open ? "bg-emerald-500" : "bg-rose-500"}`} />
            {open ? "Đang mở cửa" : "Đang đóng cửa"}
          </p>
        )}
        <h1 className="max-w-3xl text-4xl font-semibold leading-tight tracking-tight sm:text-6xl">{p.heading}</h1>
        {p.subheading && <p className={`mt-5 max-w-2xl text-lg ${img ? "text-white/85" : "text-[var(--c-muted)]"}`}>{p.subheading}</p>}
        {link && p.cta_label && (
          <a href={link} className={`${btn} mt-9 bg-[var(--c-primary)] text-white`}>{p.cta_label}</a>
        )}
      </div>
    </section>
  );
}

function TextBlock({ p }: { p: any }) {
  return (
    <Wrap>
      <div className="max-w-3xl">
        {p.heading && <H2>{p.heading}</H2>}
        <RichText text={p.body} className="text-base leading-relaxed text-[var(--c-text)]/90" />
      </div>
    </Wrap>
  );
}

function Gallery({ p }: { p: any }) {
  const images = (Array.isArray(p.images) ? p.images : []).filter((x: any) => safeHref("", x?.url));
  return (
    <Wrap tone="surface">
      {p.heading && <H2>{p.heading}</H2>}
      {images.length === 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((i) => <div key={i} className="aspect-[4/3] overflow-hidden rounded-[var(--radius)]"><Placeholder label="Chưa có ảnh" /></div>)}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {images.map((im: any, i: number) => (
            <figure key={i} className="overflow-hidden rounded-[var(--radius)]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={im.url} alt={im.alt || ""} loading="lazy" className="aspect-[4/3] w-full object-cover" />
            </figure>
          ))}
        </div>
      )}
    </Wrap>
  );
}

function ItemCard({ item, showPrice, orderHref }: { item: CatalogItem; showPrice: boolean; orderHref: string | null }) {
  return (
    <article className="flex flex-col overflow-hidden rounded-[var(--radius)] border border-black/5 bg-[var(--c-bg)]">
      {item.image_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.image_url} alt={item.name} loading="lazy" className="aspect-[4/3] w-full object-cover" />
      ) : null}
      <div className="flex flex-1 flex-col gap-1 p-4">
        <h3 className="font-medium leading-snug">{item.name}</h3>
        {item.description && <p className="line-clamp-2 text-sm text-[var(--c-muted)]">{item.description}</p>}
        <div className="mt-auto flex items-end justify-between gap-2 pt-2">
          {showPrice && item.price != null ? (
            <p className="font-semibold text-[var(--c-primary)]">
              {vnd(item.price)}{item.rate_unit ? <span className="text-xs font-normal text-[var(--c-muted)]"> / {RATE_UNIT_LABELS[item.rate_unit]}</span> : null}
            </p>
          ) : <span />}
          {!item.available ? (
            <span className="text-xs text-[var(--c-muted)]">Tạm hết</span>
          ) : orderHref ? (
            <a href={`${orderHref}?them=${item.id}`} className="text-xs font-semibold text-[var(--c-primary)] hover:underline">Đặt</a>
          ) : null}
        </div>
        {item.deposit ? <p className="text-xs text-[var(--c-muted)]">Cọc {vnd(item.deposit)}</p> : null}
      </div>
    </article>
  );
}

function orderHrefOf(ctx: SiteContext) {
  const o = ctx.site.online;
  return o && (o.accept_orders || o.accept_reservations) ? `${ctx.base}/dat-hang` : null;
}

function Catalog({ p, ctx }: { p: any; ctx: SiteContext }) {
  const items = ctx.catalog.filter((i) => !p.category || i.category === p.category);
  const groups = new Map<string, CatalogItem[]>();
  for (const i of items) groups.set(i.category, [...(groups.get(i.category) ?? []), i]);
  const orderHref = orderHrefOf(ctx);
  return (
    <Wrap>
      {p.heading && <H2>{p.heading}</H2>}
      {items.length === 0 ? <p className="text-[var(--c-muted)]">Danh mục đang cập nhật.</p> : (
        <div className="space-y-10">
          {[...groups.entries()].map(([cat, list]) => (
            <div key={cat}>
              {groups.size > 1 && <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-[var(--c-muted)]">{cat}</h3>}
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {list.map((i) => <ItemCard key={i.id} item={i} showPrice={p.show_prices !== false} orderHref={orderHref} />)}
              </div>
            </div>
          ))}
        </div>
      )}
    </Wrap>
  );
}

function Featured({ p, ctx }: { p: any; ctx: SiteContext }) {
  const limit = Math.min(Math.max(Number(p.limit) || 6, 1), 24);
  const items = [...ctx.catalog].filter((i) => i.available)
    .sort((a, b) => (b.sold_30d ?? 0) - (a.sold_30d ?? 0)).slice(0, limit);
  if (items.length === 0) return null;
  const orderHref = orderHrefOf(ctx);
  return (
    <Wrap tone="surface">
      {p.heading && <H2>{p.heading}</H2>}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((i) => <ItemCard key={i.id} item={i} showPrice orderHref={orderHref} />)}
      </div>
    </Wrap>
  );
}

function Hours({ p, ctx }: { p: any; ctx: SiteContext }) {
  const rows = hoursByDay(ctx.site.opening_hours || []);
  const today = (() => { const d = new Date().getDay(); return d === 0 ? 7 : d; })();
  return (
    <Wrap>
      {p.heading && <H2>{p.heading}</H2>}
      {ctx.site.opening_hours?.length ? (
        <dl className="max-w-md divide-y divide-black/5">
          {rows.map((r) => (
            <div key={r.day} className={`flex justify-between py-2.5 ${r.day === today ? "font-semibold" : ""}`}>
              <dt>{DAY_LABELS[r.day]}</dt>
              <dd className="tabular-nums text-[var(--c-muted)]">{r.ranges.length ? r.ranges.join(", ") : "Nghỉ"}</dd>
            </div>
          ))}
        </dl>
      ) : <p className="text-[var(--c-muted)]">Gọi trước để biết giờ mở cửa.</p>}
    </Wrap>
  );
}

function MapBlock({ p, ctx }: { p: any; ctx: SiteContext }) {
  const src = mapEmbedUrl(ctx.site);
  const link = mapLinkUrl(ctx.site);
  return (
    <Wrap tone="surface">
      {p.heading && <H2>{p.heading}</H2>}
      {ctx.site.address && <p className="mb-4 text-[var(--c-muted)]">{ctx.site.address}</p>}
      {src ? (
        <div className="overflow-hidden rounded-[var(--radius)] border border-black/5">
          <iframe title="Bản đồ" src={src} loading="lazy" referrerPolicy="no-referrer-when-downgrade" className="h-80 w-full" />
        </div>
      ) : <p className="text-[var(--c-muted)]">Chưa có địa chỉ.</p>}
      {link && <a href={link} target="_blank" rel="noopener noreferrer" className="mt-3 inline-block text-sm font-medium text-[var(--c-primary)] hover:underline">Mở Google Maps chỉ đường →</a>}
    </Wrap>
  );
}

function Contact({ p, ctx }: { p: any; ctx: SiteContext }) {
  const c = contactLinks(ctx.site);
  const items = [
    c.tel && { label: `Gọi ${c.phone}`, href: c.tel },
    c.zalo && { label: "Nhắn Zalo", href: c.zalo },
    c.messenger && { label: "Messenger", href: c.messenger },
    c.facebook && { label: "Facebook", href: c.facebook },
  ].filter(Boolean) as { label: string; href: string }[];
  return (
    <Wrap>
      {p.heading && <H2>{p.heading}</H2>}
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-1 text-[var(--c-muted)]">
          <p className="text-lg font-medium text-[var(--c-text)]">{ctx.site.name}</p>
          {ctx.site.address && <p>{ctx.site.address}</p>}
          {c.phone && <p>{c.phone}</p>}
        </div>
        <div className="flex flex-wrap content-start gap-3">
          {items.map((i, idx) => (
            <a key={i.href} href={i.href} target={i.href.startsWith("tel:") ? undefined : "_blank"} rel="noopener noreferrer"
              className={`${btn} ${idx === 0 ? "bg-[var(--c-primary)] text-white" : "border border-[var(--c-primary)] text-[var(--c-primary)]"}`}>
              {i.label}
            </a>
          ))}
        </div>
      </div>
    </Wrap>
  );
}

function CtaOrder({ p, ctx }: { p: any; ctx: SiteContext }) {
  const link = orderHrefOf(ctx);
  if (!link) return null;
  return (
    <section className="bg-[var(--c-primary)] text-white">
      <div className="mx-auto flex max-w-6xl flex-col items-start gap-5 px-4 py-14 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div>
          <h2 className="text-2xl font-semibold sm:text-3xl">{p.heading}</h2>
          {p.body && <p className="mt-2 text-white/85">{p.body}</p>}
        </div>
        <a href={link} className={`${btn} shrink-0 bg-white text-[var(--c-primary)]`}>{p.label || "Đặt ngay"}</a>
      </div>
    </section>
  );
}

function Testimonials({ p }: { p: any }) {
  const items = (Array.isArray(p.items) ? p.items : []).filter((x: any) => x?.quote);
  if (!items.length) return null;
  return (
    <Wrap tone="surface">
      {p.heading && <H2>{p.heading}</H2>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((x: any, i: number) => (
          <blockquote key={i} className="rounded-[var(--radius)] bg-[var(--c-bg)] p-6">
            <p className="leading-relaxed">“{x.quote}”</p>
            {x.name && <footer className="mt-3 text-sm text-[var(--c-muted)]">— {x.name}</footer>}
          </blockquote>
        ))}
      </div>
    </Wrap>
  );
}

function Faq({ p }: { p: any }) {
  const items = (Array.isArray(p.items) ? p.items : []).filter((x: any) => x?.q);
  if (!items.length) return null;
  return (
    <Wrap>
      {p.heading && <H2>{p.heading}</H2>}
      <div className="max-w-3xl divide-y divide-black/10 border-y border-black/10">
        {items.map((x: any, i: number) => (
          <details key={i} className="group py-4">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
              {x.q}<span className="text-[var(--c-muted)] transition group-open:rotate-45">+</span>
            </summary>
            <RichText text={x.a} className="mt-3 text-[var(--c-muted)]" />
          </details>
        ))}
      </div>
    </Wrap>
  );
}

export function SectionView({ section, ctx }: { section: Section; ctx: SiteContext }) {
  const p = section.props || {};
  switch (section.type) {
    case "hero": return <Hero p={p} ctx={ctx} />;
    case "text": return <TextBlock p={p} />;
    case "image_gallery": return <Gallery p={p} />;
    case "catalog": return <Catalog p={p} ctx={ctx} />;
    case "featured_items": return <Featured p={p} ctx={ctx} />;
    case "hours": return <Hours p={p} ctx={ctx} />;
    case "map": return <MapBlock p={p} ctx={ctx} />;
    case "contact": return <Contact p={p} ctx={ctx} />;
    case "cta_order": return <CtaOrder p={p} ctx={ctx} />;
    case "testimonials": return <Testimonials p={p} />;
    case "faq": return <Faq p={p} />;
    default: return null;
  }
}

export function SectionList({ sections, ctx }: { sections: Section[]; ctx: SiteContext }) {
  return <>{(sections || []).filter((s) => s.visible !== false).map((s) => <SectionView key={s.id} section={s} ctx={ctx} />)}</>;
}
