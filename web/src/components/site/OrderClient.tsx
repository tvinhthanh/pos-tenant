"use client";

import React, { useEffect, useMemo, useState } from "react";
import PhoneLogin, { useCustomerSession } from "@/components/site/PhoneLogin";
import { rpc } from "@/utils/customerAuth";
import {
  href, vnd, FULFILLMENT_LABELS, RATE_UNIT_LABELS,
  type CatalogItem, type Fulfillment, type PublicSite,
} from "@/utils/site";

const input = "w-full rounded-[var(--radius)] border border-black/15 bg-white px-3 py-2.5 text-base text-[var(--c-text)] focus:border-[var(--c-primary)] focus:outline-none";
const primary = "rounded-[var(--radius)] bg-[var(--c-primary)] px-5 py-3 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

type CartLine = { id: number; quantity: number };
type Result = { id: number; code: string; status: string; quoted_total: number };

/** "2026-11-15T10:30" (giờ máy khách) ⇄ ISO */
function localInput(d: Date) {
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function OrderClient({ site, catalog, base }: { site: PublicSite; catalog: CatalogItem[]; base: string }) {
  const rental = site.business_type === "rental";
  const online = site.online;
  const open = rental ? online?.accept_reservations : online?.accept_orders;
  const session = useCustomerSession();
  const cartKey = `cart:${site.shop}`;

  const [cart, setCart] = useState<CartLine[]>([]);
  const [name, setName] = useState("");
  const [ful, setFul] = useState<Fulfillment>(online?.fulfillments?.[0] ?? "pickup");
  const [when, setWhen] = useState("");
  const [start, setStart] = useState(() => localInput(new Date(Date.now() + 24 * 3600e3)));
  const [end, setEnd] = useState(() => localInput(new Date(Date.now() + 48 * 3600e3)));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<Result | null>(null);

  // Giỏ lưu trong máy, thêm món từ link "?them=<id>" trên trang danh mục
  useEffect(() => {
    let saved: CartLine[] = [];
    try { saved = JSON.parse(localStorage.getItem(cartKey) || "[]"); } catch { saved = []; }
    const add = Number(new URLSearchParams(window.location.search).get("them"));
    if (add && catalog.some((c) => c.id === add) && !saved.some((l) => l.id === add)) saved = [...saved, { id: add, quantity: 1 }];
    setCart(saved.filter((l) => catalog.some((c) => c.id === l.id && c.available)));
  }, [cartKey, catalog]);
  useEffect(() => {
    try { localStorage.setItem(cartKey, JSON.stringify(cart)); } catch { /* chế độ riêng tư */ }
  }, [cart, cartKey]);

  useEffect(() => {
    if (!session) return;
    rpc<{ full_name: string | null }>("my_customer_account").then((a) => setName((n) => n || a.full_name || "")).catch(() => {});
  }, [session]);

  const byId = useMemo(() => new Map(catalog.map((c) => [c.id, c])), [catalog]);
  const orderable = (c: CatalogItem) => c.available && !c.has_options && c.price != null;
  const setQty = (id: number, q: number) =>
    setCart((cs) => (q <= 0 ? cs.filter((l) => l.id !== id) : cs.some((l) => l.id === id) ? cs.map((l) => (l.id === id ? { ...l, quantity: q } : l)) : [...cs, { id, quantity: q }]));
  const qtyOf = (id: number) => cart.find((l) => l.id === id)?.quantity ?? 0;

  // Xem trước: giá đặt món theo danh mục; giá thuê chỉ hiển thị đơn giá — số chính xác do shop tính
  const subtotal = rental ? null : cart.reduce((s, l) => s + (byId.get(l.id)?.price ?? 0) * l.quantity, 0);
  const belowMin = !rental && online && subtotal != null && subtotal < online.min_order_amount;

  const submit = async () => {
    setBusy(true); setErr("");
    try {
      const payload = rental
        ? {
            kind: "reservation", contact_name: name, note,
            lines: cart.map((l) => ({ item_id: l.id, quantity: l.quantity, start: new Date(start).toISOString(), end: new Date(end).toISOString() })),
          }
        : {
            kind: "order", contact_name: name, note, fulfillment: ful,
            requested_for: when ? new Date(when).toISOString() : null,
            items: cart.map((l) => ({ product_id: l.id, quantity: l.quantity })),
          };
      const res = await rpc<Result>("submit_online_request", { p_shop: site.shop, p_payload: payload });
      setResult(res);
      setCart([]);
    } catch (e) {
      setErr((e as Error).message || "Không gửi được đơn.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="mx-auto max-w-xl px-4 py-20 text-center sm:px-6">
        <h1 className="text-2xl font-semibold">Shop chưa nhận {rental ? "đặt lịch" : "đặt hàng"} online</h1>
        <p className="mt-3 text-[var(--c-muted)]">Vui lòng gọi hoặc nhắn shop để đặt.</p>
        <a href={href(base, "/")} className="mt-6 inline-block text-[var(--c-primary)] hover:underline">← Về trang chủ</a>
      </div>
    );
  }

  if (result) {
    const auto = result.status === "auto_confirmed";
    return (
      <div className="mx-auto max-w-xl px-4 py-20 text-center sm:px-6">
        <p className="text-sm font-medium text-[var(--c-muted)]">Mã đơn {result.code}</p>
        <h1 className="mt-2 text-3xl font-semibold">{auto ? "Shop đã nhận đơn của bạn" : "Đã gửi, chờ shop xác nhận"}</h1>
        <p className="mt-3 text-[var(--c-muted)]">
          {auto ? "Đơn đã được xác nhận tự động. " : "Shop sẽ xác nhận trong ít phút. "}
          Tạm tính {vnd(result.quoted_total)}, thanh toán tại shop.
        </p>
        <a href={href(base, "/tai-khoan")} className={`${primary} mt-8 inline-block`}>Theo dõi đơn</a>
      </div>
    );
  }

  const choices = catalog.filter(orderable);
  return (
    <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 lg:grid-cols-[1fr_380px]">
      <section>
        <h1 className="text-3xl font-semibold tracking-tight">{rental ? "Đặt lịch thuê" : "Đặt hàng"}</h1>
        {online?.notice && <p className="mt-3 rounded-[var(--radius)] bg-[var(--c-surface)] p-3 text-sm">{online.notice}</p>}
        {choices.length === 0 ? (
          <p className="mt-8 text-[var(--c-muted)]">Chưa có món đặt online được.</p>
        ) : (
          <ul className="mt-8 divide-y divide-black/10">
            {choices.map((c) => {
              const q = qtyOf(c.id);
              return (
                <li key={c.id} className="flex items-center justify-between gap-4 py-4">
                  <div className="min-w-0">
                    <p className="font-medium">{c.name}</p>
                    <p className="text-sm text-[var(--c-muted)]">
                      {vnd(c.price)}{c.rate_unit ? ` / ${RATE_UNIT_LABELS[c.rate_unit]}` : ""}
                      {c.deposit ? ` · cọc ${vnd(c.deposit)}` : ""}
                    </p>
                  </div>
                  {q === 0 ? (
                    <button onClick={() => setQty(c.id, 1)} className="shrink-0 rounded-[var(--radius)] border border-[var(--c-primary)] px-4 py-2 text-sm font-semibold text-[var(--c-primary)]">Thêm</button>
                  ) : (
                    <div className="flex shrink-0 items-center gap-2">
                      <button onClick={() => setQty(c.id, q - 1)} aria-label={`Bớt ${c.name}`} className="h-9 w-9 rounded-full border border-black/15">−</button>
                      <span className="w-6 text-center tabular-nums">{q}</span>
                      <button onClick={() => setQty(c.id, q + 1)} aria-label={`Thêm ${c.name}`} className="h-9 w-9 rounded-full border border-black/15">+</button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {catalog.some((c) => c.has_options && c.available) && (
          <p className="mt-4 text-xs text-[var(--c-muted)]">Món có tùy chọn (size, topping…) vui lòng gọi tại quầy.</p>
        )}
      </section>

      <aside className="h-fit space-y-5 rounded-[var(--radius)] border border-black/10 bg-[var(--c-surface)] p-6 lg:sticky lg:top-24">
        <h2 className="text-lg font-semibold">Đơn của bạn</h2>
        {cart.length === 0 ? <p className="text-sm text-[var(--c-muted)]">Chưa chọn món.</p> : (
          <ul className="space-y-1.5 text-sm">
            {cart.map((l) => (
              <li key={l.id} className="flex justify-between gap-3">
                <span>{byId.get(l.id)?.name} × {l.quantity}</span>
                {!rental && <span className="tabular-nums">{vnd((byId.get(l.id)?.price ?? 0) * l.quantity)}</span>}
              </li>
            ))}
          </ul>
        )}
        {subtotal != null && cart.length > 0 && (
          <p className="flex justify-between border-t border-black/10 pt-3 font-semibold"><span>Tạm tính</span><span className="tabular-nums">{vnd(subtotal)}</span></p>
        )}
        {belowMin && <p className="text-sm text-amber-700">Đơn tối thiểu {vnd(online!.min_order_amount)}.</p>}

        {session === undefined ? null : !session ? (
          <PhoneLogin title="Đăng nhập để gửi đơn" />
        ) : (
          <div className="space-y-3">
            <label className="block text-sm font-medium">Tên người nhận
              <input value={name} onChange={(e) => setName(e.target.value)} className={`${input} mt-1`} autoComplete="name" />
            </label>
            {rental ? (
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-sm font-medium">Nhận đồ
                  <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={`${input} mt-1 text-sm`} />
                </label>
                <label className="block text-sm font-medium">Trả đồ
                  <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className={`${input} mt-1 text-sm`} />
                </label>
              </div>
            ) : (
              <>
                {(online?.fulfillments?.length ?? 0) > 1 && (
                  <fieldset className="flex flex-wrap gap-2">
                    <legend className="mb-1 text-sm font-medium">Hình thức</legend>
                    {online!.fulfillments.map((f) => (
                      <label key={f} className={`cursor-pointer rounded-[var(--radius)] border px-3 py-2 text-sm ${ful === f ? "border-[var(--c-primary)] text-[var(--c-primary)]" : "border-black/15"}`}>
                        <input type="radio" name="ful" value={f} checked={ful === f} onChange={() => setFul(f)} className="sr-only" />
                        {FULFILLMENT_LABELS[f]}
                      </label>
                    ))}
                  </fieldset>
                )}
                <label className="block text-sm font-medium">Giờ hẹn lấy (không bắt buộc)
                  <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className={`${input} mt-1 text-sm`} />
                </label>
              </>
            )}
            <label className="block text-sm font-medium">Ghi chú
              <textarea value={note} onChange={(e) => setNote(e.target.value.slice(0, 500))} rows={2} className={`${input} mt-1 text-sm`} />
            </label>
            {err && <p role="alert" className="text-sm text-rose-600">{err}</p>}
            <button onClick={submit} disabled={busy || cart.length === 0 || !name.trim() || Boolean(belowMin)} className={`${primary} w-full`}>
              {busy ? "Đang gửi…" : rental ? "Gửi yêu cầu đặt lịch" : "Gửi đơn"}
            </button>
            <p className="text-xs text-[var(--c-muted)]">Thanh toán tại shop khi nhận{rental ? " (kèm tiền cọc)" : ""}. Giá cuối cùng do shop xác nhận.</p>
          </div>
        )}
      </aside>
    </div>
  );
}
