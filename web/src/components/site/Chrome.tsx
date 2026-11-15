/**
 * Đầu trang, chân trang và nút liên hệ nổi của website shop. Không dùng JS phía
 * khách: menu điện thoại là <details>.
 */
import React from "react";
import { contactLinks, href, hoursByDay, DAY_LABELS, type PublicSite } from "@/utils/site";

export function SiteHeader({ site, base, current }: { site: PublicSite; base: string; current?: string }) {
  const online = site.online;
  const orderLabel = online?.accept_reservations ? "Đặt lịch" : online?.accept_orders ? "Đặt hàng" : null;
  const link = (path: string) => href(base, path);
  return (
    <header className="sticky top-0 z-30 border-b border-black/5 bg-[var(--c-bg)]/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <a href={link("/")} className="flex min-w-0 items-center gap-2.5">
          {site.logo_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={site.logo_url} alt="" className="h-9 w-9 rounded-[var(--radius)] object-cover" />
          )}
          <span className="truncate text-lg font-semibold">{site.name}</span>
        </a>

        <nav aria-label="Trang" className="hidden items-center gap-6 text-sm md:flex">
          {site.nav.map((n) => (
            <a key={n.path} href={link(n.path)}
              aria-current={current === n.path ? "page" : undefined}
              className={current === n.path ? "font-semibold text-[var(--c-primary)]" : "text-[var(--c-muted)] hover:text-[var(--c-text)]"}>
              {n.title}
            </a>
          ))}
          <a href={link("/tai-khoan")} className="text-[var(--c-muted)] hover:text-[var(--c-text)]">Tài khoản</a>
          {orderLabel && (
            <a href={link("/dat-hang")} className="rounded-[var(--radius)] bg-[var(--c-primary)] px-4 py-2 font-semibold text-white hover:opacity-90">
              {orderLabel}
            </a>
          )}
        </nav>

        <details className="relative md:hidden">
          <summary className="list-none rounded-[var(--radius)] border border-black/10 px-3 py-1.5 text-sm" aria-label="Mở menu">Menu</summary>
          <div className="absolute right-0 mt-2 w-56 overflow-hidden rounded-[var(--radius)] border border-black/10 bg-[var(--c-bg)] py-1 shadow-xl">
            {site.nav.map((n) => (
              <a key={n.path} href={link(n.path)} className="block px-4 py-2.5 text-sm hover:bg-[var(--c-surface)]">{n.title}</a>
            ))}
            <a href={link("/tai-khoan")} className="block px-4 py-2.5 text-sm hover:bg-[var(--c-surface)]">Tài khoản</a>
            {orderLabel && <a href={link("/dat-hang")} className="block px-4 py-2.5 text-sm font-semibold text-[var(--c-primary)] hover:bg-[var(--c-surface)]">{orderLabel}</a>}
          </div>
        </details>
      </div>
    </header>
  );
}

export function SiteFooter({ site, base }: { site: PublicSite; base: string }) {
  const c = contactLinks(site);
  const open = hoursByDay(site.opening_hours || []).filter((r) => r.ranges.length);
  return (
    <footer className="border-t border-black/5 bg-[var(--c-surface)]">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 text-sm sm:grid-cols-3 sm:px-6">
        <div className="space-y-1.5">
          <p className="text-base font-semibold">{site.name}</p>
          {site.tagline && <p className="text-[var(--c-muted)]">{site.tagline}</p>}
          {site.address && <p className="text-[var(--c-muted)]">{site.address}</p>}
          {c.phone && <p><a href={c.tel!} className="hover:underline">{c.phone}</a></p>}
        </div>
        <div>
          <p className="mb-2 font-semibold">Giờ mở cửa</p>
          {open.length ? (
            <ul className="space-y-1 text-[var(--c-muted)]">
              {open.slice(0, 7).map((r) => <li key={r.day}>{DAY_LABELS[r.day]}: {r.ranges.join(", ")}</li>)}
            </ul>
          ) : <p className="text-[var(--c-muted)]">Liên hệ để biết giờ mở cửa.</p>}
        </div>
        <div className="space-y-1.5">
          <p className="mb-2 font-semibold">Trang</p>
          {site.nav.map((n) => <a key={n.path} href={href(base, n.path)} className="block text-[var(--c-muted)] hover:underline">{n.title}</a>)}
        </div>
      </div>
      <p className="pb-8 text-center text-xs text-[var(--c-muted)]">© {new Date().getFullYear()} {site.name}</p>
    </footer>
  );
}

/** Nút gọi / Zalo nổi góc màn hình */
export function FloatingContact({ site }: { site: PublicSite }) {
  const c = contactLinks(site);
  if (!c.zalo && !c.tel) return null;
  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col gap-2">
      {c.zalo && (
        <a href={c.zalo} target="_blank" rel="noopener noreferrer" aria-label="Nhắn Zalo"
          className="flex h-12 w-12 items-center justify-center rounded-full bg-[#0068ff] text-xs font-bold text-white shadow-lg">Zalo</a>
      )}
      {c.tel && (
        <a href={c.tel} aria-label={`Gọi ${c.phone}`}
          className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--c-primary)] text-white shadow-lg">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z" /></svg>
        </a>
      )}
    </div>
  );
}
