"use client";

import React, { useCallback, useEffect, useState } from "react";
import PhoneLogin, { useCustomerSession } from "@/components/site/PhoneLogin";
import TransferQR from "@/components/site/TransferQR";
import { customerClient, rpc } from "@/utils/customerAuth";
import { href, vnd, type PublicSite } from "@/utils/site";

type MyRequest = {
  id: number; code: string; kind: "order" | "reservation"; status: string; quoted_total: number;
  requested_for: string | null; created_at: string; reject_reason: string | null; fulfilled: boolean | null;
  items: { name: string; quantity: number }[];
};

const STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: "Chờ shop xác nhận", tone: "bg-amber-100 text-amber-800" },
  confirmed: { label: "Đã xác nhận", tone: "bg-emerald-100 text-emerald-800" },
  auto_confirmed: { label: "Đã xác nhận", tone: "bg-emerald-100 text-emerald-800" },
  rejected: { label: "Shop từ chối", tone: "bg-rose-100 text-rose-800" },
  expired: { label: "Hết hạn chờ", tone: "bg-black/5 text-[var(--c-muted)]" },
  cancelled: { label: "Đã hủy", tone: "bg-black/5 text-[var(--c-muted)]" },
};

const fmt = (iso: string) => new Date(iso).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });

export default function AccountClient({ site, base }: { site: PublicSite; base: string }) {
  const session = useCustomerSession();
  const [list, setList] = useState<MyRequest[] | null>(null);
  const [loyalty, setLoyalty] = useState<{ points: number; tier: string } | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const [l, p] = await Promise.all([
        rpc<MyRequest[]>("my_online_requests", { p_shop: site.shop }),
        rpc<{ points: number; tier: string } | null>("my_loyalty", { p_shop: site.shop }),
      ]);
      setList(l); setLoyalty(p); setErr("");
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [site.shop]);

  useEffect(() => {
    if (!session) return;
    load();
    // Trạng thái đơn đổi khi shop xác nhận: tải lại mỗi 20 giây
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [session, load]);

  const cancel = async (id: number) => {
    try { await rpc("cancel_my_online_request", { p_request_id: id }); load(); }
    catch (e) { setErr((e as Error).message); }
  };

  if (session === undefined) return <div className="min-h-[50vh]" />;
  if (!session) {
    return <div className="px-4 py-16 sm:px-6"><PhoneLogin title="Đăng nhập để xem đơn của bạn" /></div>;
  }

  const phone = session.user.phone ? `0${session.user.phone.replace(/^\+?84/, "")}` : "";
  return (
    <div className="mx-auto max-w-3xl space-y-8 px-4 py-12 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Tài khoản</h1>
          <p className="mt-1 text-[var(--c-muted)]">{phone}</p>
        </div>
        <button onClick={() => customerClient().auth.signOut()} className="text-sm text-[var(--c-muted)] hover:underline">Đăng xuất</button>
      </div>

      {loyalty && (
        <div className="flex items-center justify-between rounded-[var(--radius)] bg-[var(--c-surface)] p-5">
          <div><p className="text-sm text-[var(--c-muted)]">Điểm tích lũy tại {site.name}</p><p className="text-2xl font-semibold tabular-nums">{loyalty.points}</p></div>
          <span className="rounded-full bg-[var(--c-primary)] px-3 py-1 text-xs font-semibold text-white">Hạng {loyalty.tier}</span>
        </div>
      )}

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Đơn của bạn</h2>
          <a href={href(base, "/dat-hang")} className="text-sm font-medium text-[var(--c-primary)] hover:underline">Đặt mới</a>
        </div>
        {err && <p role="alert" className="mb-3 text-sm text-rose-600">{err}</p>}
        {list === null ? <p className="text-sm text-[var(--c-muted)]">Đang tải…</p> : list.length === 0 ? (
          <p className="text-sm text-[var(--c-muted)]">Bạn chưa có đơn nào ở shop này.</p>
        ) : (
          <ul className="space-y-3">
            {list.map((r) => {
              const s = STATUS[r.status] ?? { label: r.status, tone: "" };
              return (
                <li key={r.id} className="rounded-[var(--radius)] border border-black/10 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">{r.code} <span className="text-sm font-normal text-[var(--c-muted)]">· {fmt(r.created_at)}</span></p>
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${r.fulfilled ? "bg-emerald-100 text-emerald-800" : s.tone}`}>
                      {r.fulfilled ? "Hoàn tất" : s.label}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-[var(--c-muted)]">{(r.items || []).map((i) => `${i.name} × ${i.quantity}`).join(", ")}</p>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="tabular-nums">{vnd(r.quoted_total)}{r.requested_for ? ` · hẹn ${fmt(r.requested_for)}` : ""}</span>
                    {r.status === "pending" && <button onClick={() => cancel(r.id)} className="text-rose-600 hover:underline">Hủy đơn</button>}
                  </div>
                  {r.reject_reason && r.status !== "pending" && <p className="mt-2 text-sm text-rose-700">Lý do: {r.reject_reason}</p>}
                  {site.online?.bank_transfer && r.kind === "order" && !r.fulfilled
                    && (r.status === "confirmed" || r.status === "auto_confirmed") && <TransferQR requestId={r.id} compact />}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
