"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Landmark, Phone, Search, Settings2 } from "lucide-react";
import api, { supabase } from "@/utils/api";
import { ErrorLine, Field, Modal, NumberInput, PageHead, inputCls } from "@/components/RetailUi";
import { errorText, toast } from "@/components/Toaster";
import {
  cancelOnlineOrder, completeDraft, confirmOnline, confirmOnlinePayment, draftStatus, getOnlineSettings,
  getPaymentSettings, listOnlineRequests, rejectOnline, saveOnlineSettings, savePaymentSettings,
  type OnlineRequest, type OnlineSettings, type PaymentSettings,
} from "@/utils/website";
import { FULFILLMENT_LABELS, vnd, type Fulfillment } from "@/utils/site";
import { VN_BANKS, bankName, findTransferCodes, toAccountName } from "@/utils/vietqr";

const STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: "Chờ xác nhận", tone: "bg-amber-500/10 text-amber-600" },
  confirmed: { label: "Đã xác nhận", tone: "bg-emerald-500/10 text-emerald-500" },
  auto_confirmed: { label: "Tự xác nhận", tone: "bg-emerald-500/10 text-emerald-500" },
  rejected: { label: "Đã từ chối", tone: "bg-rose-500/10 text-rose-500" },
  expired: { label: "Hết hạn", tone: "bg-slate-800 text-slate-400" },
  cancelled: { label: "Đã hủy", tone: "bg-slate-800 text-slate-400" },
};
const fmt = (iso: string) => new Date(iso).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });

export default function OnlinePage() {
  const qc = useQueryClient();
  const [scope, setScope] = useState<"open" | "all">("open");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bankOpen, setBankOpen] = useState(false);
  // Đối soát: dán nội dung CK / tin báo ngân hàng → lọc đơn có mã khớp
  const [reconcile, setReconcile] = useState("");
  // "Bây giờ" cập nhật mỗi 30 giây: đếm ngược hết hạn, lọc đơn trong ngày
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const { data: me } = useQuery({ queryKey: ["currentUser"], queryFn: async () => (await api.get("/api/v1/auth/me")).data });
  const isManager = me?.role === "owner" || me?.role === "manager" || me?.role === "superadmin";
  const isOwner = me?.role === "owner" || me?.role === "superadmin";
  const businessType: string = me?.business_type ?? "fnb";

  const { data: list = [], isLoading, error } = useQuery({
    queryKey: ["onlineRequests", scope],
    queryFn: () => listOnlineRequests(scope),
    refetchInterval: 30_000,
  });
  const orderIds = useMemo(() => list.filter((r) => r.converted_kind === "sales_order" && r.converted_ref).map((r) => r.converted_ref!), [list]);
  const { data: drafts = {} } = useQuery({ queryKey: ["onlineDrafts", orderIds], queryFn: () => draftStatus(orderIds), enabled: orderIds.length > 0 });

  // Đơn mới đến: Realtime (RLS chỉ gửi đơn của shop mình)
  useEffect(() => {
    const ch = supabase.channel("online-requests-page")
      .on("postgres_changes", { event: "*", schema: "public", table: "online_requests" }, () => {
        qc.invalidateQueries({ queryKey: ["onlineRequests"] });
        qc.invalidateQueries({ queryKey: ["onlinePendingCount"] });
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [qc]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["onlineRequests"] });
    qc.invalidateQueries({ queryKey: ["onlineDrafts"] });
    qc.invalidateQueries({ queryKey: ["onlinePendingCount"] });
  };

  // Đơn "đang mở": còn chờ, hoặc đã xác nhận nhưng chưa thu tiền / chưa hủy
  const codes = findTransferCodes(reconcile);
  const shown = codes.length > 0
    ? list.filter((r) => codes.includes(r.transfer_code))
    : scope === "open"
    ? list.filter((r) => r.status === "pending" || (r.converted_kind === "sales_order" && drafts[r.converted_ref!]?.status === "draft")
        || (r.converted_kind === "rental_contract" && ["confirmed", "auto_confirmed"].includes(r.status) && new Date(r.created_at).getTime() > now - 86400e3))
    : list;

  return (
    <div className="space-y-6">
      <PageHead title="Đơn online" sub="Đơn khách đặt từ website. Xác nhận đơn món / hàng → thành đơn nháp đã giữ hàng; khách trả tại quầy hoặc chuyển khoản VietQR.">
        {isOwner && (
          <button onClick={() => setBankOpen(true)} className="flex items-center gap-1.5 rounded-xl border border-slate-800 px-3 py-2 text-xs text-slate-300 hover:bg-slate-900">
            <Landmark className="h-4 w-4" /> Tài khoản nhận tiền
          </button>
        )}
        {isManager && (
          <button onClick={() => setSettingsOpen(true)} className="flex items-center gap-1.5 rounded-xl border border-slate-800 px-3 py-2 text-xs text-slate-300 hover:bg-slate-900">
            <Settings2 className="h-4 w-4" /> Cài đặt nhận đơn
          </button>
        )}
      </PageHead>

      <div className="flex gap-2">
        {([["open", "Cần xử lý"], ["all", "Tất cả"]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setScope(k)}
            className={`rounded-full border px-3 py-1.5 text-xs font-medium ${scope === k ? "border-indigo-500 bg-indigo-500/10 text-indigo-500" : "border-slate-800 text-slate-400"}`}>
            {label}
          </button>
        ))}
        <label className="relative ml-auto w-full max-w-sm">
          <span className="sr-only">Đối soát chuyển khoản</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" aria-hidden="true" />
          <input value={reconcile} onChange={(e) => setReconcile(e.target.value)}
            placeholder="Đối soát: dán nội dung CK / tin báo ngân hàng"
            className={`${inputCls} pl-9 text-xs`} />
        </label>
      </div>
      {reconcile.trim() && (
        <p className="text-xs text-slate-400">
          {codes.length === 0 ? "Không thấy mã đơn (dạng OL000123ABCD) trong nội dung vừa dán."
            : shown.length === 0 ? `Mã ${codes.join(", ")} không khớp đơn nào trong 100 đơn gần nhất.`
            : `Khớp ${shown.length} đơn theo mã ${codes.join(", ")}. Kiểm số tiền rồi bấm "Đã nhận CK".`}
        </p>
      )}

      {error && <ErrorLine text={errorText(error, "Không tải được đơn online.")} />}
      {isLoading && <p className="text-sm text-slate-500">Đang tải…</p>}
      {!isLoading && shown.length === 0 && (
        <div className="rounded-2xl border border-dashed border-slate-800 p-10 text-center text-sm text-slate-400">
          Không có đơn cần xử lý.{isManager && <> Bật nhận đơn ở <button onClick={() => setSettingsOpen(true)} className="font-semibold text-indigo-500 hover:underline">Cài đặt</button>.</>}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {shown.map((r) => (
          <RequestCard key={r.id} r={r} now={now} draft={r.converted_ref ? drafts[r.converted_ref] : undefined} isManager={isManager} onDone={refresh} />
        ))}
      </div>

      {settingsOpen && <SettingsDialog businessType={businessType} onClose={() => setSettingsOpen(false)} />}
      {bankOpen && <BankDialog onClose={() => setBankOpen(false)} />}
    </div>
  );
}

function RequestCard({ r, now, draft, isManager, onDone }: {
  r: OnlineRequest; now: number; draft?: { status: string; final_amount: number }; isManager: boolean; onDone: () => void;
}) {
  const [dialog, setDialog] = useState<null | "reject" | "pay" | "cancel" | "transfer">(null);
  const s = STATUS[r.status];
  const minsLeft = Math.round((new Date(r.expires_at).getTime() - now) / 60000);
  const confirm = useMutation({
    mutationFn: () => confirmOnline(r.id),
    onSuccess: () => { toast.success(r.kind === "order" ? "Đã xác nhận, đơn nháp đã giữ hàng" : "Đã tạo hợp đồng đặt trước"); onDone(); },
    onError: (e) => toast.error(errorText(e, "Không xác nhận được.")),
  });
  const items = r.kind === "order"
    ? (r.payload.display || []).map((i) => `${i.name} × ${i.quantity}`)
    : (r.payload.lines || []).map((l) => `${l.name} × ${l.quantity} (${fmt(l.start)} → ${fmt(l.end)})`);

  return (
    <article className={`space-y-3 rounded-2xl border bg-slate-900 p-5 ${r.status === "pending" ? "border-amber-500/40" : "border-slate-800"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-slate-100">{r.code} <span className="text-xs font-normal text-slate-500">· {fmt(r.created_at)}</span></p>
          <p className="mt-0.5 flex items-center gap-1.5 text-sm text-slate-300">
            {r.contact_name} · <a href={`tel:${r.contact_phone}`} className="inline-flex items-center gap-1 text-indigo-500 hover:underline"><Phone className="h-3.5 w-3.5" />{r.contact_phone}</a>
          </p>
        </div>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${draft?.status === "completed" ? "bg-emerald-500/10 text-emerald-500" : s.tone}`}>
          {draft?.status === "completed" ? "Đã thu tiền" : s.label}
        </span>
      </div>
      <ul className="space-y-0.5 text-sm text-slate-300">{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
        <span className="font-semibold text-slate-100">{vnd(r.quoted_total)}</span>
        {r.kind === "order" && <span>{FULFILLMENT_LABELS[r.fulfillment]}</span>}
        {r.requested_for && r.kind === "order" && <span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5" />Hẹn {fmt(r.requested_for)}</span>}
        {r.status === "pending" && <span className={minsLeft < 5 ? "text-rose-500" : ""}>Tự hết hạn sau {Math.max(minsLeft, 0)} phút</span>}
        {r.kind === "order" && r.transfer_code && (
          <span title="Nội dung chuyển khoản của đơn">CK: <span className="font-mono text-slate-300">{r.transfer_code}</span>
            {r.paid_at && <span className="ml-1 text-emerald-500">· đã nhận {fmt(r.paid_at)}</span>}</span>
        )}
      </div>
      {r.note && <p className="rounded-lg bg-slate-950 p-2 text-sm text-slate-300">“{r.note}”</p>}
      {r.reject_reason && r.status !== "pending" && <p className="text-xs text-rose-500">Lý do: {r.reject_reason}</p>}

      <div className="flex flex-wrap gap-2 pt-1">
        {r.status === "pending" && (
          <>
            <button onClick={() => confirm.mutate()} disabled={confirm.isPending}
              className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
              {confirm.isPending ? "Đang xác nhận…" : "Xác nhận"}
            </button>
            <button onClick={() => setDialog("reject")} className="rounded-xl border border-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800">Từ chối</button>
          </>
        )}
        {r.converted_kind === "sales_order" && draft?.status === "draft" && (
          <>
            <button onClick={() => setDialog("pay")} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500">Thu tiền {vnd(draft.final_amount)}</button>
            {isManager && (
              <button onClick={() => setDialog("transfer")} className="rounded-xl border border-indigo-500/50 px-4 py-2 text-sm text-indigo-500 hover:bg-indigo-500/10">Đã nhận CK</button>
            )}
            {isManager && <button onClick={() => setDialog("cancel")} className="rounded-xl px-3 py-2 text-sm text-rose-500 hover:bg-rose-500/10">Khách không đến</button>}
          </>
        )}
        {r.converted_kind === "rental_contract" && r.converted_ref && (
          <Link href={`/rental/contracts/${r.converted_ref}`} className="rounded-xl border border-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800">Mở hợp đồng</Link>
        )}
      </div>

      {dialog === "reject" && <ReasonDialog title={`Từ chối ${r.code}`} hint="Khách sẽ thấy lý do này." action="Từ chối"
        onClose={() => setDialog(null)} run={(reason) => rejectOnline(r.id, reason)} onDone={onDone} />}
      {dialog === "cancel" && <ReasonDialog title={`Hủy ${r.code}`} hint="Hàng đã giữ được trả lại kho." action="Hủy đơn"
        onClose={() => setDialog(null)} run={(reason) => cancelOnlineOrder(r.id, reason)} onDone={onDone} />}
      {dialog === "pay" && draft && <PayDialog r={r} amount={draft.final_amount} onClose={() => setDialog(null)} onDone={onDone} />}
      {dialog === "transfer" && draft && <TransferDialog r={r} amount={draft.final_amount} onClose={() => setDialog(null)} onDone={onDone} />}
    </article>
  );
}

function ReasonDialog({ title, hint, action, onClose, run, onDone }: {
  title: string; hint: string; action: string; onClose: () => void; run: (reason: string) => Promise<unknown>; onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const m = useMutation({
    mutationFn: () => run(reason.trim()),
    onSuccess: () => { toast.success("Đã xử lý"); onDone(); onClose(); },
    onError: (e) => setErr(errorText(e, "Không thực hiện được.")),
  });
  return (
    <Modal title={title} onClose={onClose}>
      <Field label="Lý do" hint={hint}><input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} /></Field>
      <ErrorLine text={err} />
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="rounded-xl border border-slate-800 px-4 py-2 text-sm text-slate-300">Đóng</button>
        <button onClick={() => m.mutate()} disabled={!reason.trim() || m.isPending} className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-500 disabled:opacity-50">{action}</button>
      </div>
    </Modal>
  );
}

function PayDialog({ r, amount, onClose, onDone }: { r: OnlineRequest; amount: number; onClose: () => void; onDone: () => void }) {
  const [method, setMethod] = useState("cash");
  const [err, setErr] = useState("");
  const m = useMutation({
    mutationFn: () => completeDraft(r.converted_ref!, method, amount),
    onSuccess: () => { toast.success(`Đã thu ${vnd(amount)}`); onDone(); onClose(); },
    onError: (e) => setErr(errorText(e, "Không thu tiền được.")),
  });
  return (
    <Modal title={`Thu tiền ${r.code}`} onClose={onClose}>
      <p className="text-2xl font-bold tabular-nums text-slate-100">{vnd(amount)}</p>
      <div className="grid grid-cols-3 gap-2">
        {[["cash", "Tiền mặt"], ["bank_transfer", "Chuyển khoản"], ["card", "Thẻ"]].map(([k, label]) => (
          <button key={k} onClick={() => setMethod(k)} className={`rounded-xl border py-2 text-sm ${method === k ? "border-indigo-500 bg-indigo-500/10 text-indigo-500" : "border-slate-800 text-slate-400"}`}>{label}</button>
        ))}
      </div>
      <ErrorLine text={err} />
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="rounded-xl border border-slate-800 px-4 py-2 text-sm text-slate-300">Đóng</button>
        <button onClick={() => m.mutate()} disabled={m.isPending} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">Đã thu</button>
      </div>
    </Modal>
  );
}

// Quản lý đối chiếu sao kê / app ngân hàng rồi xác nhận — không có API ngân hàng
function TransferDialog({ r, amount, onClose, onDone }: { r: OnlineRequest; amount: number; onClose: () => void; onDone: () => void }) {
  const [ref, setRef] = useState("");
  const [err, setErr] = useState("");
  const m = useMutation({
    mutationFn: () => confirmOnlinePayment(r.id, ref.trim()),
    onSuccess: () => { toast.success(`Đã ghi nhận ${vnd(amount)} chuyển khoản`); onDone(); onClose(); },
    onError: (e) => setErr(errorText(e, "Không ghi nhận được.")),
  });
  return (
    <Modal title={`Đã nhận chuyển khoản ${r.code}`} onClose={onClose}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-slate-400">Số tiền</dt><dd className="text-xl font-bold tabular-nums text-slate-100">{vnd(amount)}</dd>
        <dt className="text-slate-400">Nội dung CK</dt><dd className="font-mono text-slate-100">{r.transfer_code}</dd>
        <dt className="text-slate-400">Khách</dt><dd className="text-slate-300">{r.contact_name} · {r.contact_phone}</dd>
      </dl>
      <p className="text-xs text-amber-600">Chỉ bấm khi đã thấy tiền về tài khoản với đúng số tiền và nội dung trên. Khoản thu ghi vào ca đang mở.</p>
      <Field label="Mã giao dịch ngân hàng" hint="Không bắt buộc — để trống thì lưu nội dung CK">
        <input value={ref} maxLength={100} onChange={(e) => setRef(e.target.value)} className={inputCls} />
      </Field>
      <ErrorLine text={err} />
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="rounded-xl border border-slate-800 px-4 py-2 text-sm text-slate-300">Đóng</button>
        <button onClick={() => { setErr(""); m.mutate(); }} disabled={m.isPending}
          className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">
          {m.isPending ? "Đang ghi…" : "Xác nhận đã nhận tiền"}
        </button>
      </div>
    </Modal>
  );
}

function BankDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["paymentSettings"], queryFn: getPaymentSettings });
  const [s, setS] = useState<PaymentSettings | null>(null);
  const [err, setErr] = useState("");
  const v: PaymentSettings = s ?? data ?? { bank_transfer_enabled: false, bank_bin: "", bank_account_no: "", bank_account_name: "" };
  const set = (patch: Partial<PaymentSettings>) => setS({ ...v, ...patch });
  const known = VN_BANKS.some((b) => b.bin === v.bank_bin);
  const [otherBin, setOtherBin] = useState(false);

  const m = useMutation({
    mutationFn: () => savePaymentSettings({
      bank_transfer_enabled: v.bank_transfer_enabled, bank_bin: v.bank_bin || null,
      bank_account_no: v.bank_account_no?.trim() || null, bank_account_name: v.bank_account_name?.trim() || null,
    }),
    onSuccess: () => { toast.success("Đã lưu tài khoản nhận tiền"); qc.invalidateQueries({ queryKey: ["paymentSettings"] }); onClose(); },
    onError: (e) => setErr(errorText(e, "Không lưu được.")),
  });

  return (
    <Modal title="Tài khoản nhận chuyển khoản" onClose={onClose}>
      {isLoading ? <p className="text-sm text-slate-400">Đang tải…</p> : (
        <>
          <p className="text-xs text-slate-400">Khách thấy mã VietQR (đã điền số tiền và nội dung) sau khi shop xác nhận đơn. Chỉ chủ shop sửa được mục này.</p>
          <Field label="Ngân hàng">
            {!otherBin && (known || !v.bank_bin) ? (
              <select value={v.bank_bin ?? ""} className={inputCls}
                onChange={(e) => (e.target.value === "khac" ? setOtherBin(true) : set({ bank_bin: e.target.value }))}>
                <option value="">— Chọn ngân hàng —</option>
                {VN_BANKS.map((b) => <option key={b.bin} value={b.bin}>{b.name}</option>)}
                <option value="khac">Ngân hàng khác (nhập mã BIN)…</option>
              </select>
            ) : (
              <input value={v.bank_bin ?? ""} inputMode="numeric" maxLength={6} placeholder="Mã BIN 6 số, VD: 970436"
                onChange={(e) => set({ bank_bin: e.target.value.replace(/\D/g, "") })} className={`${inputCls} font-mono`} />
            )}
          </Field>
          <Field label="Số tài khoản">
            <input value={v.bank_account_no ?? ""} maxLength={19} onChange={(e) => set({ bank_account_no: e.target.value.replace(/[^0-9A-Za-z]/g, "") })}
              className={`${inputCls} font-mono`} />
          </Field>
          <Field label="Tên chủ tài khoản" hint="In hoa không dấu, đúng như ngân hàng hiển thị">
            <input value={v.bank_account_name ?? ""} onChange={(e) => set({ bank_account_name: toAccountName(e.target.value) })} className={inputCls} />
          </Field>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-200">
            <input type="checkbox" className="h-4 w-4 accent-indigo-500" checked={v.bank_transfer_enabled}
              onChange={(e) => set({ bank_transfer_enabled: e.target.checked })} />
            Cho khách chuyển khoản qua VietQR{v.bank_bin ? ` (${bankName(v.bank_bin)})` : ""}
          </label>
          <ErrorLine text={err} />
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="rounded-xl border border-slate-800 px-4 py-2 text-sm text-slate-300">Hủy</button>
            <button onClick={() => { setErr(""); m.mutate(); }} disabled={m.isPending}
              className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">Lưu</button>
          </div>
        </>
      )}
    </Modal>
  );
}

function SettingsDialog({ businessType, onClose }: { businessType: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["onlineSettings"], queryFn: getOnlineSettings });
  const [s, setS] = useState<Partial<OnlineSettings> | null>(null);
  const [err, setErr] = useState("");
  const v = s ?? data ?? null;
  const set = (patch: Partial<OnlineSettings>) => setS({ ...(v || {}), ...patch });
  const rental = businessType === "rental";
  const fulOptions: Fulfillment[] = businessType === "fnb" ? ["pickup", "dine_in", "delivery"] : ["pickup", "delivery"];

  const m = useMutation({
    mutationFn: () => saveOnlineSettings({
      accept_orders: v?.accept_orders, accept_reservations: v?.accept_reservations, fulfillments: v?.fulfillments,
      auto_confirm_under: v?.auto_confirm_under || null, auto_confirm_requires_history: v?.auto_confirm_requires_history,
      max_pending_per_customer: v?.max_pending_per_customer, pending_expire_minutes: v?.pending_expire_minutes,
      min_order_amount: v?.min_order_amount ?? 0, notice: v?.notice?.trim() || null,
    }),
    onSuccess: () => { toast.success("Đã lưu cài đặt"); qc.invalidateQueries({ queryKey: ["onlineSettings"] }); onClose(); },
    onError: (e) => setErr(errorText(e, "Không lưu được. Kiểm tra lại các giá trị.")),
  });

  if (!v) return <Modal title="Cài đặt nhận đơn online" onClose={onClose}><p className="text-sm text-slate-400">Shop chưa có website. Tạo website trước ở mục Website.</p></Modal>;

  return (
    <Modal title="Cài đặt nhận đơn online" onClose={onClose} wide>
      <label className="flex items-center gap-2 text-sm font-medium text-slate-200">
        <input type="checkbox" className="h-4 w-4 accent-indigo-500"
          checked={Boolean(rental ? v.accept_reservations : v.accept_orders)}
          onChange={(e) => set(rental ? { accept_reservations: e.target.checked } : { accept_orders: e.target.checked })} />
        {rental ? "Nhận đặt lịch thuê từ website" : "Nhận đặt hàng từ website"}
      </label>
      {!rental && (
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium text-slate-400">Hình thức nhận hàng</legend>
          <div className="flex flex-wrap gap-3">
            {fulOptions.map((f) => (
              <label key={f} className="flex items-center gap-1.5 text-sm text-slate-300">
                <input type="checkbox" className="h-4 w-4 accent-indigo-500" checked={(v.fulfillments || []).includes(f)}
                  onChange={(e) => set({ fulfillments: e.target.checked ? [...(v.fulfillments || []), f] : (v.fulfillments || []).filter((x) => x !== f) })} />
                {FULFILLMENT_LABELS[f]}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {!rental && (
          <Field label="Tự xác nhận đơn dưới (đ)" hint="Để trống = luôn chờ nhân viên. Cần ca đang mở.">
            <NumberInput value={v.auto_confirm_under ?? ""} onChange={(x) => set({ auto_confirm_under: x === "" ? null : x })} />
          </Field>
        )}
        {!rental && (
          <Field label="Đơn tối thiểu (đ)"><NumberInput value={v.min_order_amount ?? 0} onChange={(x) => set({ min_order_amount: x === "" ? 0 : x })} /></Field>
        )}
        <Field label="Mỗi khách tối đa đơn chờ" hint="1–10"><NumberInput value={v.max_pending_per_customer ?? 2} onChange={(x) => set({ max_pending_per_customer: x === "" ? 1 : x })} /></Field>
        <Field label="Đơn chờ tự hết hạn sau (phút)" hint="5–1440"><NumberInput value={v.pending_expire_minutes ?? 30} onChange={(x) => set({ pending_expire_minutes: x === "" ? 30 : x })} /></Field>
      </div>
      {!rental && v.auto_confirm_under ? (
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" className="h-4 w-4 accent-indigo-500" checked={v.auto_confirm_requires_history !== false}
            onChange={(e) => set({ auto_confirm_requires_history: e.target.checked })} />
          Chỉ tự xác nhận khách đã từng mua (chống đơn ảo)
        </label>
      ) : null}
      <Field label="Lời nhắn trên trang đặt hàng"><textarea value={v.notice ?? ""} maxLength={500} rows={2} onChange={(e) => set({ notice: e.target.value })} className={inputCls} /></Field>
      <ErrorLine text={err} />
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="rounded-xl border border-slate-800 px-4 py-2 text-sm text-slate-300">Hủy</button>
        <button onClick={() => { setErr(""); m.mutate(); }} disabled={m.isPending || (!rental && v.accept_orders && !(v.fulfillments || []).length)}
          className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">Lưu</button>
      </div>
    </Modal>
  );
}
