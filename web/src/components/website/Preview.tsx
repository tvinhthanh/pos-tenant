"use client";

import React, { useState } from "react";
import { Monitor, Smartphone } from "lucide-react";
import { SectionList } from "@/components/site/Sections";
import { SiteFooter, SiteHeader } from "@/components/site/Chrome";
import { themeVars, type CatalogItem, type PublicSite, type Section } from "@/utils/site";

/**
 * Xem trước bằng đúng component của website. Link trong khung xem trước không điều hướng.
 * Khung điện thoại dùng container hẹp 390px.
 */
export default function Preview({ site, sections, catalog }: { site: PublicSite; sections: Section[]; catalog: CatalogItem[] }) {
  const [mobile, setMobile] = useState(false);
  return (
    <div className="flex h-full min-h-0 flex-col rounded-2xl border border-slate-800 bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Xem trước bản nháp</span>
        <div className="inline-flex rounded-lg border border-slate-800 p-0.5" role="radiogroup" aria-label="Khổ màn hình">
          <button role="radio" aria-checked={!mobile} onClick={() => setMobile(false)} aria-label="Máy tính"
            className={`rounded-md p-1.5 ${!mobile ? "bg-slate-800 text-slate-100" : "text-slate-500"}`}><Monitor className="h-4 w-4" /></button>
          <button role="radio" aria-checked={mobile} onClick={() => setMobile(true)} aria-label="Điện thoại"
            className={`rounded-md p-1.5 ${mobile ? "bg-slate-800 text-slate-100" : "text-slate-500"}`}><Smartphone className="h-4 w-4" /></button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-slate-950 p-3">
        <div
          style={{ ...(themeVars(site.theme) as React.CSSProperties), fontFamily: "var(--font)", background: "var(--c-bg)", color: "var(--c-text)" }}
          className={`mx-auto origin-top overflow-hidden rounded-xl shadow-xl ${mobile ? "w-[390px]" : "w-full"} [&_header]:!static`}
          onClickCapture={(e) => { if ((e.target as HTMLElement).closest("a")) e.preventDefault(); }}
        >
          <SiteHeader site={site} base="" />
          {sections.length === 0 ? (
            <p className="p-12 text-center text-sm opacity-60">Trang trống — thêm khối ở bên trái.</p>
          ) : (
            <SectionList sections={sections} ctx={{ site, catalog, base: "" }} />
          )}
          <SiteFooter site={site} base="" />
        </div>
      </div>
    </div>
  );
}
