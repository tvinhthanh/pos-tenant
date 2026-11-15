"use client";

/**
 * Khối dùng chung của màn bán lẻ / đổi hàng:
 *  - PaymentBox: một phương thức hoặc tách nhiều phương thức (Σ phải đúng số cần thu)
 *  - DiscountApprovalModal: quản lý nhập PIN tại quầy, hoặc chờ duyệt từ xa
 *  - PendingApprovalsPanel: quản lý duyệt / từ chối yêu cầu của thu ngân
 */
import React, { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, ShieldCheck, Trash2 } from "lucide-react";
import api from "@/utils/api";
import {
  approveDiscountWithPin, getApprovalStatus, listDiscountApprovers, listPendingRetailApprovals,
  resolveRetailApproval, vnd, fmtTime, PAY_METHOD_LABELS, type PayMethod,
} from "@/utils/retail";
import { errorText, toast } from "@/components/Toaster";
import { ErrorLine, Field, Modal, NumberInput, inputCls } from "@/components/RetailUi";

export const PAY_METHODS: PayMethod[] = ["cash", "bank_transfer", "card", "momo"];

export type PayRow = { method: PayMethod; amount: number | "" };

/** Khoản thanh toán gửi lên DB. Một dòng = trả đủ bằng phương thức đó. */
export function resolvePayments(rows: PayRow[], total: number) {
  if (total <= 0) return [];
  if (rows.length <= 1) return [{ method: rows[0]?.method ?? "cash", amount: total }];
  return rows.filter((r) => Number(r.amount) > 0).map((r) => ({ method: r.method, amount: Number(r.amount) }));
}

export function paymentsSum(rows: PayRow[], total: number) {
  return resolvePayments(rows, total).reduce((s, p) => s + p.amount, 0);
}

export function payLabel(rows: PayRow[], total: number) {
  const pays = resolvePayments(rows, total);
  if (pays.length === 0) return "Không thu tiền";
  return pays.map((p) => (pays.length > 1 ? `${PAY_METHOD_LABELS[p.method]} ${vnd(p.amount)}` : PAY_METHOD_LABELS[p.method])).join(" + ");
}

/**
 * Chọn phương thức / tách thanh toán + tiền khách đưa (chỉ phần tiền mặt).
 * Hợp lệ khi Σ các khoản = total; DB kiểm lại lần nữa.
 */
export function PaymentBox({
  total, rows, setRows, given, setGiven,
}: {
  total: number;
  rows: PayRow[];
  setRows: (r: PayRow[]) => void;
  given: number | "";
  setGiven: (v: number | "") => void;
}) {
  const split = rows.length > 1;
  const sum = paymentsSum(rows, total);
  const cashPart = resolvePayments(rows, total).filter((p) => p.method === "cash").reduce((s, p) => s + p.amount, 0);
  const change = given === "" ? 0 : Number(given) - cashPart;
  const setRow = (i: number, patch: Partial<PayRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remainingFor = (i: number) => Math.max(0, total - rows.reduce((s, r, j) => (j === i ? s : s + Number(r.amount || 0)), 0));

  if (total <= 0) return <p className="text-sm text-slate-400">Không cần thu tiền.</p>;

  return (
    <div className="space-y-2">
      {!split ? (
        <div className="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label="Phương thức thanh toán">
          {PAY_METHODS.map((m) => (
            <button key={m} role="radio" aria-checked={rows[0]?.method === m} onClick={() => setRows([{ method: m, amount: "" }])}
              className={`rounded-xl border px-1 py-2 text-xs font-medium ${rows[0]?.method === m ? "border-indigo-500 bg-indigo-500/10 text-indigo-500" : "border-slate-800 text-slate-400"}`}>
              {PAY_METHOD_LABELS[m]}
            </button>
          ))}
        </div>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r, i) => (
            <li key={i} className="flex items-center gap-1.5">
              <select value={r.method} onChange={(e) => setRow(i, { method: e.target.value as PayMethod })} aria-label={`Phương thức ${i + 1}`}
                className={`${inputCls} w-32 shrink-0 py-1.5`}>
                {PAY_METHODS.map((m) => <option key={m} value={m}>{PAY_METHOD_LABELS[m]}</option>)}
              </select>
              <NumberInput value={r.amount} onChange={(v) => setRow(i, { amount: v })} placeholder="Số tiền" aria-label={`Số tiền khoản ${i + 1}`} className="py-1.5" />
              <button onClick={() => setRow(i, { amount: remainingFor(i) })} title="Điền phần còn lại"
                className="shrink-0 rounded-lg border border-slate-800 px-2 py-1.5 text-[11px] text-slate-300 hover:bg-slate-800">Còn lại</button>
              <button onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Bỏ khoản này" className="shrink-0 text-slate-500 hover:text-rose-500">
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between text-xs">
        <button
          onClick={() => {
            if (!split) setRows([{ method: rows[0]?.method ?? "cash", amount: total }, { method: rows[0]?.method === "cash" ? "card" : "cash", amount: "" }]);
            else setRows([...rows, { method: "cash", amount: "" }]);
          }}
          className="flex items-center gap-1 text-indigo-500 hover:underline">
          <Plus className="h-3.5 w-3.5" /> {split ? "Thêm phương thức" : "Tách thanh toán"}
        </button>
        {split && (
          <span className={sum === total ? "text-emerald-500" : "text-rose-500"}>
            {sum === total ? "Đã đủ" : sum < total ? `Còn thiếu ${vnd(total - sum)}` : `Dư ${vnd(sum - total)}`}
          </span>
        )}
      </div>

      {cashPart > 0 && (
        <div className="space-y-2">
          <input value={given} onChange={(e) => setGiven(e.target.value === "" ? "" : Math.max(0, Number(e.target.value.replace(/\D/g, ""))))}
            inputMode="numeric" placeholder={split ? `Khách đưa tiền mặt (${vnd(cashPart)})` : "Khách đưa"} aria-label="Tiền khách đưa"
            className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-right text-base tabular-nums text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none" />
          <div className="flex flex-wrap gap-1.5">
            {[cashPart, ...[50000, 100000, 200000, 500000].filter((v) => v > cashPart)].slice(0, 4).map((v) => (
              <button key={v} onClick={() => setGiven(v)} className="rounded-lg border border-slate-800 px-2 py-1 text-xs tabular-nums text-slate-300 hover:bg-slate-800">{vnd(v)}</button>
            ))}
          </div>
          {given !== "" && (
            <p className={`flex justify-between text-sm font-semibold ${change < 0 ? "text-rose-500" : "text-emerald-500"}`}>
              <span>{change < 0 ? "Còn thiếu" : "Tiền thối"}</span><span className="tabular-nums">{vnd(Math.abs(change))}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Thanh toán hợp lệ để bấm: Σ đúng và tiền mặt khách đưa (nếu nhập) đủ. */
export function paymentReady(rows: PayRow[], total: number, given: number | "") {
  if (paymentsSum(rows, total) !== total) return false;
  const cashPart = resolvePayments(rows, total).filter((p) => p.method === "cash").reduce((s, p) => s + p.amount, 0);
  return given === "" || cashPart === 0 || Number(given) >= cashPart;
}

const LEVEL_LABEL = { manager: "quản lý", owner: "chủ cửa hàng" } as const;

/**
 * Giảm giá vượt thẩm quyền: quản lý nhập PIN ngay tại máy thu ngân,
 * hoặc để yêu cầu chờ duyệt từ xa (tự kiểm tra 4 giây / lần).
 */
export function DiscountApprovalModal({
  request, onApproved, onClose,
}: {
  request: { request_id: number; required_level: "manager" | "owner"; amount: number };
  onApproved: () => void;
  onClose: () => void;
}) {
  const [approverId, setApproverId] = useState("");
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  // PIN và theo dõi từ xa có thể cùng báo "đã duyệt" — chỉ thanh toán tiếp một lần
  const doneRef = useRef(false);
  const approved = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onApproved();
  };
  const { data: approvers = [], isLoading } = useQuery({ queryKey: ["discountApprovers"], queryFn: listDiscountApprovers });
  const eligible = approvers.filter((a) => request.required_level !== "owner" || a.role === "owner");

  useEffect(() => {
    if (!approverId && eligible.length > 0) setApproverId(eligible[0].id);
  }, [approverId, eligible]);

  // Duyệt từ xa: theo dõi trạng thái phiếu
  const { data: status } = useQuery({
    queryKey: ["approvalStatus", request.request_id],
    queryFn: () => getApprovalStatus(request.request_id),
    refetchInterval: 4000,
  });
  useEffect(() => {
    if (status === "approved") approved();
  });

  const verify = useMutation({
    mutationFn: () => approveDiscountWithPin(request.request_id, approverId, pin),
    onSuccess: (res) => {
      setPin("");
      if (res.ok) { toast.success("Quản lý đã duyệt giảm giá"); approved(); return; }
      if (res.locked_until) setErr(`Sai PIN quá nhiều lần — PIN người duyệt bị khóa đến ${fmtTime(res.locked_until)}.`);
      else setErr(`Sai mã PIN. Còn ${res.attempts_left} lần thử.`);
    },
    onError: (e) => setErr(errorText(e, "Không duyệt được.")),
  });

  return (
    <Modal title="Giảm giá cần duyệt" onClose={onClose}>
      <p className="text-sm text-slate-300">
        Giảm <b className="tabular-nums text-slate-100">{vnd(request.amount)}</b> vượt mức thu ngân được tự áp —
        cần <b>{LEVEL_LABEL[request.required_level]}</b> duyệt (yêu cầu #{request.request_id}).
      </p>

      <form onSubmit={(e) => { e.preventDefault(); setErr(""); verify.mutate(); }} className="space-y-3 rounded-xl border border-slate-800 p-4">
        <p className="flex items-center gap-2 text-sm font-semibold text-slate-200"><KeyRound className="h-4 w-4 text-indigo-500" /> Duyệt ngay tại quầy</p>
        {isLoading ? <p className="text-sm text-slate-500">Đang tải…</p> : eligible.length === 0 ? (
          <p className="text-sm text-amber-600">Chưa có {LEVEL_LABEL[request.required_level]} nào đặt mã PIN ở shop này. Dùng cách chờ duyệt bên dưới.</p>
        ) : (
          <>
            <Field label="Người duyệt">
              <select value={approverId} onChange={(e) => setApproverId(e.target.value)} className={inputCls}>
                {eligible.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.role === "owner" ? "Chủ" : "Quản lý"}</option>)}
              </select>
            </Field>
            <Field label="Mã PIN của người duyệt">
              <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} type="password" inputMode="numeric"
                autoComplete="off" autoFocus className={`${inputCls} tracking-[0.4em]`} />
            </Field>
            <button type="submit" disabled={pin.length < 4 || !approverId || verify.isPending}
              className="w-full rounded-xl bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">
              {verify.isPending ? "Đang kiểm tra…" : "Duyệt & thanh toán"}
            </button>
          </>
        )}
        <ErrorLine text={err} />
      </form>

      <div className="rounded-xl border border-dashed border-slate-800 p-4 text-sm text-slate-400">
        <p className="font-semibold text-slate-300">Hoặc chờ duyệt từ xa</p>
        <p>Quản lý mở màn <b>Trả hàng</b> → mục &quot;Yêu cầu chờ duyệt&quot;. Duyệt xong, đơn tự thanh toán tiếp.</p>
        <p className="mt-1 text-xs">
          Trạng thái: {status === "rejected" ? <span className="text-rose-500">đã bị từ chối</span>
            : status === "approved" ? <span className="text-emerald-500">đã duyệt</span> : "đang chờ…"}
        </p>
      </div>
    </Modal>
  );
}

const ROLE_RANK: Record<string, number> = { staff: 1, manager: 2, owner: 3, superadmin: 4 };

/** Quản lý / chủ: danh sách yêu cầu chờ duyệt của shop (trả hàng, đổi hàng, giảm giá tay). */
export function PendingApprovalsPanel() {
  const qc = useQueryClient();
  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: async () => (await api.get("/api/v1/auth/me")).data as { role: string; id?: string },
  });
  const rank = ROLE_RANK[me?.role ?? "staff"] ?? 1;
  const { data: rows = [] } = useQuery({
    queryKey: ["retailApprovals"], queryFn: listPendingRetailApprovals, enabled: rank >= 2, refetchInterval: 15000,
  });
  const resolve = useMutation({
    mutationFn: ({ id, ok }: { id: number; ok: boolean }) => resolveRetailApproval(id, ok),
    onSuccess: (_d, v) => {
      toast.success(v.ok ? "Đã duyệt" : "Đã từ chối");
      qc.invalidateQueries({ queryKey: ["retailApprovals"] });
      qc.invalidateQueries({ queryKey: ["retailReturns"] });
      qc.invalidateQueries({ queryKey: ["retailCatalog"] });
    },
    onError: (e) => toast.error(errorText(e, "Không xử lý được yêu cầu.")),
  });

  if (rank < 2 || rows.length === 0) return null;
  const kindLabel = (r: (typeof rows)[number]) =>
    r.entity_type === "manual_discount" ? "Giảm giá tay"
      : r.details.payload?.kind === "goods_exchange" ? `Đổi hàng · hóa đơn #${r.entity_id}`
        : r.details.payload?.kind === "goods_return" ? `Trả hàng · hóa đơn #${r.entity_id}` : `Hoàn tiền · hóa đơn #${r.entity_id}`;

  return (
    <section className="space-y-2">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-300"><ShieldCheck className="h-4 w-4 text-indigo-500" /> Yêu cầu chờ duyệt</h2>
      <ul className="divide-y divide-slate-800 rounded-2xl border border-slate-800">
        {rows.map((r) => {
          const level = r.details.required_level ?? "owner";
          const can = rank >= (level === "owner" ? 3 : 2);
          return (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
              <span className="text-slate-200">
                #{r.id} · {kindLabel(r)} · <b className="tabular-nums">{vnd(r.details.value)}</b>
                <span className="block text-xs text-slate-500">{r.note || "—"} · {fmtTime(r.created_at)} · cần {LEVEL_LABEL[level]}</span>
              </span>
              {can ? (
                <span className="flex gap-1.5">
                  <button disabled={resolve.isPending} onClick={() => resolve.mutate({ id: r.id, ok: false })}
                    className="rounded-lg border border-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800">Từ chối</button>
                  <button disabled={resolve.isPending} onClick={() => resolve.mutate({ id: r.id, ok: true })}
                    className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500">Duyệt</button>
                </span>
              ) : <span className="text-xs text-slate-500">Chờ chủ cửa hàng</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
