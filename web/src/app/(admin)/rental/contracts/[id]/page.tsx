"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, CheckCircle2, Clock, Printer, X } from "lucide-react";
import api from "@/utils/api";
import { getBranchProfile } from "@/utils/rpc";
import { printRentalContract, printSettlementReceipt } from "@/utils/rental-print";
import {
  addRentalCharge, cancelRental, checkOutRental, extendRental, fmtTime, getContractDetail, resolveApproval,
  returnRental, settleRental, toLocalInput, fromLocalInput, vnd,
  CHARGE_LABELS, CONTRACT_STATUS_LABELS, LINE_STATUS_LABELS, PAY_METHOD_LABELS, RATE_UNIT_LABELS,
  type ChargeType, type ContractDetail, type PayMethod,
} from "@/utils/rental";
import { errorText, toast } from "@/components/Toaster";

const input = "w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none";
const btn = "rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-50";
const btnPrimary = `${btn} bg-indigo-600 text-white hover:bg-indigo-500`;
const btnGhost = `${btn} border border-slate-800 text-slate-300 hover:bg-slate-900`;

type Dialog = null | "return" | "settle" | "charge" | "cancel" | { extend: number };

export default function ContractPage() {
  const { id } = useParams<{ id: string }>();
  const contractId = Number(id);
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["rentalContract", contractId],
    queryFn: () => getContractDetail(contractId),
    enabled: Number.isFinite(contractId),
  });
  const { data: me } = useQuery({
    queryKey: ["currentUser"],
    queryFn: async () => (await api.get("/api/v1/auth/me")).data as { role: string },
  });
  const isManager = me?.role === "owner" || me?.role === "manager" || me?.role === "superadmin";
  const isOwner = me?.role === "owner" || me?.role === "superadmin";

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["rentalContract", contractId] });
    queryClient.invalidateQueries({ queryKey: ["rentalBoard"] });
    queryClient.invalidateQueries({ queryKey: ["rentalContracts"] });
    queryClient.invalidateQueries({ queryKey: ["rentalOverdue"] });
    queryClient.invalidateQueries({ queryKey: ["rentalCalendar"] });
  };

  const print = useMutation({
    mutationFn: async (kind: "contract" | "settlement") => {
      const shop = await queryClient.fetchQuery({ queryKey: ["branchProfile"], queryFn: getBranchProfile, staleTime: 5 * 60_000 });
      if (!data) return;
      if (kind === "contract") printRentalContract(data, shop);
      else printSettlementReceipt(data, shop);
    },
    onError: (e) => toast.error(errorText(e, "Không in được.")),
  });

  const checkOut = useMutation({
    mutationFn: () => checkOutRental(contractId),
    onSuccess: () => { toast.success("Đã giao đồ cho khách"); refresh(); },
    onError: (e) => toast.error(errorText(e, "Không giao đồ được.")),
  });
  const resolve = useMutation({
    mutationFn: ({ rid, approve }: { rid: number; approve: boolean }) => resolveApproval(rid, approve),
    onSuccess: (_d, v) => { toast.success(v.approve ? "Đã duyệt" : "Đã từ chối"); refresh(); },
    onError: (e) => toast.error(errorText(e, "Không xử lý được yêu cầu.")),
  });

  if (isLoading) return <p className="text-sm text-slate-500">Đang tải…</p>;
  if (error || !data) return <p className="text-sm text-rose-500">{errorText(error, "Không tải được hợp đồng.")}</p>;

  const { contract: c, customer, lines, balance } = data;
  const outLines = lines.filter((l) => l.status === "out");
  const overdue = outLines.some((l) => l.overdue);
  const feeSoFar = outLines.reduce((s, l) => s + (l.fee_so_far ?? 0), 0);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/rental/contracts" aria-label="Quay lại" className="rounded-lg p-2 text-slate-400 hover:bg-slate-900"><ArrowLeft className="h-5 w-5" /></Link>
        <h1 className="font-mono text-2xl font-bold text-slate-100">{c.code}</h1>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${
          overdue ? "bg-rose-500/15 text-rose-500"
          : c.status === "closed" ? "bg-emerald-500/15 text-emerald-500"
          : c.status === "cancelled" ? "bg-slate-800 text-slate-400"
          : "bg-indigo-500/15 text-indigo-500"}`}>
          {overdue ? "Quá hạn" : CONTRACT_STATUS_LABELS[c.status]}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          {c.status !== "cancelled" && (
            <button className={btnGhost} disabled={print.isPending} onClick={() => print.mutate("contract")}>
              <Printer className="mr-1 inline h-4 w-4" />In hợp đồng
            </button>
          )}
          {c.status === "closed" && (
            <button className={btnGhost} disabled={print.isPending} onClick={() => print.mutate("settlement")}>
              <Printer className="mr-1 inline h-4 w-4" />In phiếu tất toán
            </button>
          )}
          {c.status === "reserved" && (
            <>
              <button className={btnGhost} onClick={() => setDialog("cancel")}>Hủy đặt</button>
              <button className={btnPrimary} disabled={checkOut.isPending} onClick={() => checkOut.mutate()}>
                {checkOut.isPending ? "Đang giao…" : "Giao đồ"}
              </button>
            </>
          )}
          {(c.status === "active" || c.status === "returned") && (
            <button className={btnGhost} onClick={() => setDialog("charge")}>Phụ phí / giảm</button>
          )}
          {c.status === "active" && <button className={btnPrimary} onClick={() => setDialog("return")}>Nhận trả đồ</button>}
          {c.status === "returned" && <button className={btnPrimary} onClick={() => setDialog("settle")}>Tất toán</button>}
        </div>
      </div>

      {data.pending_approvals.length > 0 && (
        <div className="space-y-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
          {data.pending_approvals.map((r) => {
            const canResolve = r.required_level === "owner" ? isOwner : isManager;
            return (
              <div key={r.id} className="flex flex-wrap items-center gap-3 text-sm">
                <Clock className="h-4 w-4 text-amber-600" />
                <span className="text-amber-700 dark:text-amber-300">
                  {r.type === "charge_waiver" ? "Giảm / miễn phí" : "Giữ cọc khi hủy"} {vnd(r.value)} đang chờ
                  {r.required_level === "owner" ? " chủ cửa hàng" : " quản lý"} duyệt
                </span>
                {canResolve && (
                  <span className="ml-auto flex gap-2">
                    <button className={btnGhost} disabled={resolve.isPending} onClick={() => resolve.mutate({ rid: r.id, approve: false })}>Từ chối</button>
                    <button className={btnPrimary} disabled={resolve.isPending} onClick={() => resolve.mutate({ rid: r.id, approve: true })}>Duyệt</button>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5 md:col-span-1">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Khách</h2>
          <p className="font-semibold text-slate-100">{customer.name}</p>
          <p className="text-sm text-slate-400">{customer.phone}</p>
          {customer.id_number && <p className="mt-1 text-sm text-slate-400">{customer.id_type ?? "Giấy tờ"}: {customer.id_number}</p>}
          {customer.address && <p className="text-sm text-slate-400">{customer.address}</p>}
          {data.collateral.length > 0 && (
            <div className="mt-4 border-t border-slate-800 pt-3">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">Giấy tờ giữ lại</p>
              {data.collateral.map((g) => (
                <p key={g.id} className="text-sm text-slate-300">
                  {g.kind}{g.description ? ` · ${g.description}` : ""}{" "}
                  {g.returned_at ? <span className="text-xs text-emerald-500">(đã trả)</span> : <span className="text-xs text-amber-600">(đang giữ)</span>}
                </p>
              ))}
            </div>
          )}
          {c.notes && <p className="mt-4 border-t border-slate-800 pt-3 text-sm text-slate-400">{c.notes}</p>}
          {c.cancel_reason && <p className="mt-2 text-sm text-slate-400">Lý do hủy: {c.cancel_reason}</p>}
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5 md:col-span-2">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Tiền</h2>
          <BalanceTable detail={data} feeSoFar={feeSoFar} />
        </section>
      </div>

      <section className="overflow-x-auto rounded-2xl border border-slate-800">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-slate-900 text-left text-xs uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-4 py-2.5">Món</th>
              <th className="px-4 py-2.5">Giá</th>
              <th className="px-4 py-2.5">Thời gian</th>
              <th className="px-4 py-2.5">Trạng thái</th>
              <th className="px-4 py-2.5 text-right"> </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {lines.map((l) => (
              <tr key={l.id} className={l.overdue ? "bg-rose-500/5" : ""}>
                <td className="px-4 py-3 text-slate-100">
                  {l.item_name}
                  <span className="block text-xs text-slate-500">{l.unit_code ? `Chiếc ${l.unit_code}` : `Số lượng ${l.quantity}`}</span>
                </td>
                <td className="px-4 py-3 text-slate-300">{vnd(l.rate_price)}/{RATE_UNIT_LABELS[l.rate_unit]}</td>
                <td className="px-4 py-3 text-xs text-slate-400">
                  {fmtTime(l.checked_out_at ?? l.start)} → {l.returned_at ? fmtTime(l.returned_at) : l.end ? fmtTime(l.end) : "tính giờ"}
                  {l.overdue && <span className="mt-0.5 flex items-center gap-1 font-semibold text-rose-500"><AlertTriangle className="h-3.5 w-3.5" /> Quá hạn</span>}
                  {l.status === "out" && l.fee_so_far != null && <span className="block text-slate-500">Tạm tính {vnd(l.fee_so_far)}</span>}
                </td>
                <td className="px-4 py-3 text-xs text-slate-300">
                  {LINE_STATUS_LABELS[l.status]}
                  {l.return_condition && <span className="block text-slate-500">{l.return_condition}</span>}
                </td>
                <td className="px-4 py-3 text-right">
                  {(l.status === "out" || l.status === "reserved") && (
                    <button className="text-xs font-semibold text-indigo-500 hover:underline" onClick={() => setDialog({ extend: l.id })}>
                      Gia hạn
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {data.charges.length > 0 && (
        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Chi tiết phí</h2>
          <ul className="divide-y divide-slate-800 text-sm">
            {data.charges.map((ch) => (
              <li key={ch.id} className="flex justify-between py-2">
                <span className="text-slate-300">{CHARGE_LABELS[ch.type]}{ch.reason ? <span className="text-slate-500"> · {ch.reason}</span> : null}</span>
                <span className={`tabular-nums ${ch.amount < 0 ? "text-emerald-500" : "text-slate-100"}`}>{vnd(ch.amount)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {dialog === "return" && <ReturnDialog detail={data} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === "settle" && <SettleDialog detail={data} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === "charge" && <ChargeDialog detail={data} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === "cancel" && <CancelDialog detail={data} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog && typeof dialog === "object" && (
        <ExtendDialog detail={data} lineId={dialog.extend} onClose={() => setDialog(null)} onDone={refresh} />
      )}
    </div>
  );
}

function BalanceTable({ detail, feeSoFar }: { detail: ContractDetail; feeSoFar: number }) {
  const b = detail.balance;
  const rows: [string, number, string?][] = [
    ["Tổng phí", b.charges],
    ["Đã thanh toán", -b.paid],
    ["Cọc đã trừ vào phí", -b.deposit_applied],
  ];
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      <dl className="space-y-1.5 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between"><dt className="text-slate-400">{k}</dt><dd className="tabular-nums text-slate-200">{vnd(v)}</dd></div>
        ))}
        <div className="flex justify-between border-t border-slate-800 pt-1.5 font-semibold">
          <dt className="text-slate-200">Còn phải trả</dt><dd className="tabular-nums text-slate-100">{vnd(b.due)}</dd>
        </div>
        {feeSoFar > 0 && <p className="pt-1 text-xs text-slate-500">Đồ đang thuê tạm tính thêm {vnd(feeSoFar)} (chốt khi trả).</p>}
      </dl>
      <dl className="space-y-1.5 text-sm">
        <div className="flex justify-between"><dt className="text-slate-400">Cọc đã nhận</dt><dd className="tabular-nums text-slate-200">{vnd(b.deposit_received)}</dd></div>
        {b.deposit_refunded > 0 && <div className="flex justify-between"><dt className="text-slate-400">Đã hoàn cọc</dt><dd className="tabular-nums text-slate-200">{vnd(b.deposit_refunded)}</dd></div>}
        {b.deposit_forfeited > 0 && <div className="flex justify-between"><dt className="text-slate-400">Cọc bị giữ</dt><dd className="tabular-nums text-slate-200">{vnd(b.deposit_forfeited)}</dd></div>}
        <div className="flex justify-between border-t border-slate-800 pt-1.5 font-semibold">
          <dt className="text-slate-200">Cọc đang giữ</dt><dd className="tabular-nums text-slate-100">{vnd(b.deposit_held)}</dd>
        </div>
      </dl>
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-black/60 px-4 py-6" role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-full max-w-lg space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-slate-100">{title}</h2>
          <button onClick={onClose} aria-label="Đóng" className="rounded-lg p-1 text-slate-500 hover:text-slate-100"><X className="h-4 w-4" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function useAction<T>(fn: () => Promise<T>, success: string, onDone: () => void, onClose: () => void) {
  const [err, setErr] = useState("");
  const m = useMutation({
    mutationFn: fn,
    onSuccess: (res: any) => {
      toast.success(res?.status === "pending_approval" ? "Đã gửi yêu cầu chờ duyệt" : success);
      onDone();
      onClose();
    },
    onError: (e) => setErr(errorText(e, "Thao tác thất bại.")),
  });
  return { run: () => { setErr(""); m.mutate(); }, pending: m.isPending, err };
}

function ErrorLine({ text }: { text: string }) {
  return text ? <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 text-sm text-rose-500">{text}</p> : null;
}

function ReturnDialog({ detail, onClose, onDone }: { detail: ContractDetail; onClose: () => void; onDone: () => void }) {
  const out = detail.lines.filter((l) => l.status === "out");
  const [state, setState] = useState<Record<number, { take: boolean; condition: "ok" | "damaged" | "lost"; damage: number; note: string }>>(
    () => Object.fromEntries(out.map((l) => [l.id, { take: true, condition: "ok" as const, damage: 0, note: "" }])),
  );
  const chosen = out.filter((l) => state[l.id]?.take);
  const action = useAction(
    () => returnRental(detail.contract.id, chosen.map((l) => ({
      line_id: l.id, condition: state[l.id].condition,
      damage_amount: state[l.id].condition === "damaged" ? state[l.id].damage : undefined,
      note: state[l.id].note || undefined,
    }))),
    "Đã nhận trả đồ", onDone, onClose,
  );
  const set = (id: number, patch: Partial<(typeof state)[number]>) => setState((s) => ({ ...s, [id]: { ...s[id], ...patch } }));

  return (
    <Modal title="Nhận trả đồ" onClose={onClose}>
      <p className="text-xs text-slate-500">Tiền thuê tính theo thời gian thực đến bây giờ; trả sau hạn hẹn ghi thành phí trễ.</p>
      <div className="max-h-[50vh] space-y-3 overflow-y-auto">
        {out.map((l) => (
          <div key={l.id} className="space-y-2 rounded-xl border border-slate-800 p-3">
            <label className="flex items-center gap-2 text-sm text-slate-100">
              <input type="checkbox" checked={state[l.id].take} onChange={(e) => set(l.id, { take: e.target.checked })} />
              {l.item_name} {l.unit_code ? `· ${l.unit_code}` : `× ${l.quantity}`}
              {l.fee_so_far != null && <span className="ml-auto text-xs text-slate-500">{vnd(l.fee_so_far)}</span>}
            </label>
            {state[l.id].take && (
              <div className="grid grid-cols-3 gap-2">
                {(["ok", "damaged", "lost"] as const).map((cnd) => (
                  <button key={cnd} type="button" onClick={() => set(l.id, { condition: cnd })}
                    className={`rounded-lg border px-2 py-1.5 text-xs ${state[l.id].condition === cnd
                      ? cnd === "ok" ? "border-emerald-500 bg-emerald-500/10 text-emerald-600" : "border-rose-500 bg-rose-500/10 text-rose-500"
                      : "border-slate-800 text-slate-400"}`}>
                    {cnd === "ok" ? "Tốt" : cnd === "damaged" ? "Hư hỏng" : "Mất"}
                  </button>
                ))}
                {state[l.id].condition === "damaged" && (
                  <input type="number" min={0} step={1000} placeholder="Tiền đền hư hỏng" value={state[l.id].damage || ""}
                    onChange={(e) => set(l.id, { damage: Math.max(0, Number(e.target.value) || 0) })} className={`${input} col-span-3`} />
                )}
                {state[l.id].condition === "lost" && (
                  <p className="col-span-3 text-xs text-rose-500">Tính đền {vnd(l.replacement_value * l.quantity)} theo giá trị món.</p>
                )}
                {state[l.id].condition !== "ok" && (
                  <input placeholder="Ghi chú tình trạng" value={state[l.id].note}
                    onChange={(e) => set(l.id, { note: e.target.value })} className={`${input} col-span-3`} />
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <ErrorLine text={action.err} />
      <div className="flex justify-end gap-2">
        <button className={btnGhost} onClick={onClose}>Hủy</button>
        <button className={btnPrimary} disabled={action.pending || chosen.length === 0} onClick={action.run}>
          {action.pending ? "Đang lưu…" : `Nhận trả ${chosen.length} món`}
        </button>
      </div>
    </Modal>
  );
}

function SettleDialog({ detail, onClose, onDone }: { detail: ContractDetail; onClose: () => void; onDone: () => void }) {
  const b = detail.balance;
  const [applyDeposit, setApplyDeposit] = useState(true);
  const apply = applyDeposit ? Math.min(b.deposit_held, Math.max(b.due, 0)) : 0;
  const toCollect = Math.max(b.due - apply, 0);
  const refund = b.deposit_held - apply;
  const [method, setMethod] = useState<PayMethod>("cash");
  const [refundMethod, setRefundMethod] = useState<PayMethod>("cash");
  const action = useAction(
    () => settleRental(detail.contract.id, {
      payments: toCollect > 0 ? [{ method, amount: toCollect }] : [],
      apply_deposit: applyDeposit, refund_method: refundMethod,
    }),
    "Đã tất toán hợp đồng", onDone, onClose,
  );
  const methods = Object.keys(PAY_METHOD_LABELS) as PayMethod[];

  return (
    <Modal title="Tất toán" onClose={onClose}>
      <dl className="space-y-1.5 text-sm">
        <div className="flex justify-between"><dt className="text-slate-400">Còn phải trả</dt><dd className="tabular-nums text-slate-100">{vnd(b.due)}</dd></div>
        <div className="flex justify-between"><dt className="text-slate-400">Cọc đang giữ</dt><dd className="tabular-nums text-slate-100">{vnd(b.deposit_held)}</dd></div>
      </dl>
      <label className="flex items-center gap-2 text-sm text-slate-300">
        <input type="checkbox" checked={applyDeposit} onChange={(e) => setApplyDeposit(e.target.checked)} />
        Trừ cọc vào tiền thuê ({vnd(apply)})
      </label>
      <div className="space-y-3 rounded-xl border border-slate-800 p-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold text-slate-100">Thu thêm {vnd(toCollect)}</span>
          {toCollect > 0 && (
            <select value={method} onChange={(e) => setMethod(e.target.value as PayMethod)} className={`${input} w-40`} aria-label="Phương thức thu">
              {methods.map((m) => <option key={m} value={m}>{PAY_METHOD_LABELS[m]}</option>)}
            </select>
          )}
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold text-slate-100">Hoàn cọc {vnd(refund)}</span>
          {refund > 0 && (
            <select value={refundMethod} onChange={(e) => setRefundMethod(e.target.value as PayMethod)} className={`${input} w-40`} aria-label="Phương thức hoàn">
              {methods.map((m) => <option key={m} value={m}>{PAY_METHOD_LABELS[m]}</option>)}
            </select>
          )}
        </div>
      </div>
      {detail.collateral.some((g) => !g.returned_at) && (
        <p className="text-xs text-amber-600">Nhớ trả lại giấy tờ: {detail.collateral.filter((g) => !g.returned_at).map((g) => g.kind).join(", ")}.</p>
      )}
      <ErrorLine text={action.err} />
      <div className="flex justify-end gap-2">
        <button className={btnGhost} onClick={onClose}>Hủy</button>
        <button className={btnPrimary} disabled={action.pending} onClick={action.run}>
          <CheckCircle2 className="mr-1 inline h-4 w-4" />{action.pending ? "Đang tất toán…" : "Xác nhận tất toán"}
        </button>
      </div>
    </Modal>
  );
}

function ChargeDialog({ detail, onClose, onDone }: { detail: ContractDetail; onClose: () => void; onDone: () => void }) {
  const [type, setType] = useState<ChargeType>("sale");
  const [amount, setAmount] = useState(0);
  const [reason, setReason] = useState("");
  const isReduce = type === "discount" || type === "waiver";
  const action = useAction(
    () => addRentalCharge(detail.contract.id, { type, amount, reason: reason.trim() || undefined }),
    isReduce ? "Đã giảm phí" : "Đã thêm phí", onDone, onClose,
  );
  const types: ChargeType[] = ["sale", "cleaning", "damage", "discount", "waiver"];
  return (
    <Modal title="Phụ phí / giảm giá" onClose={onClose}>
      <div className="grid grid-cols-3 gap-2">
        {types.map((t) => (
          <button key={t} type="button" onClick={() => setType(t)}
            className={`rounded-lg border px-2 py-1.5 text-xs ${type === t ? "border-indigo-500 bg-indigo-500/10 text-indigo-500" : "border-slate-800 text-slate-400"}`}>
            {CHARGE_LABELS[t]}
          </button>
        ))}
      </div>
      <input type="number" min={0} step={1000} placeholder="Số tiền" value={amount || ""}
        onChange={(e) => setAmount(Math.max(0, Number(e.target.value) || 0))} className={input} aria-label="Số tiền" />
      <input placeholder={isReduce ? "Lý do (bắt buộc)" : "Ghi chú"} value={reason} onChange={(e) => setReason(e.target.value)} className={input} />
      {isReduce && <p className="text-xs text-slate-500">Giảm / miễn vượt ngưỡng sẽ gửi quản lý hoặc chủ cửa hàng duyệt.</p>}
      <ErrorLine text={action.err} />
      <div className="flex justify-end gap-2">
        <button className={btnGhost} onClick={onClose}>Hủy</button>
        <button className={btnPrimary} disabled={action.pending || amount <= 0 || (isReduce && !reason.trim())} onClick={action.run}>
          {action.pending ? "Đang lưu…" : "Lưu"}
        </button>
      </div>
    </Modal>
  );
}

function CancelDialog({ detail, onClose, onDone }: { detail: ContractDetail; onClose: () => void; onDone: () => void }) {
  const held = detail.balance.deposit_held;
  const [reason, setReason] = useState("");
  const [forfeit, setForfeit] = useState(0);
  const [refundMethod, setRefundMethod] = useState<PayMethod>("cash");
  const action = useAction(
    () => cancelRental(detail.contract.id, { reason: reason.trim(), forfeit_amount: forfeit, refund_method: refundMethod }),
    "Đã hủy đặt trước", onDone, onClose,
  );
  return (
    <Modal title="Hủy đặt trước" onClose={onClose}>
      <input placeholder="Lý do hủy (bắt buộc)" value={reason} onChange={(e) => setReason(e.target.value)} className={input} />
      {held > 0 && (
        <>
          <label className="block text-xs text-slate-400">
            Giữ lại bao nhiêu cọc (0 – {vnd(held)})
            <input type="number" min={0} max={held} step={1000} value={forfeit || ""}
              onChange={(e) => setForfeit(Math.min(held, Math.max(0, Number(e.target.value) || 0)))} className={`${input} mt-1`} />
          </label>
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="text-slate-300">Hoàn khách {vnd(held - forfeit)}</span>
            <select value={refundMethod} onChange={(e) => setRefundMethod(e.target.value as PayMethod)} className={`${input} w-40`} aria-label="Phương thức hoàn">
              {(Object.keys(PAY_METHOD_LABELS) as PayMethod[]).map((m) => <option key={m} value={m}>{PAY_METHOD_LABELS[m]}</option>)}
            </select>
          </div>
          {forfeit > 0 && <p className="text-xs text-slate-500">Giữ cọc cần quản lý trở lên; nhân viên sẽ tạo yêu cầu chờ duyệt.</p>}
        </>
      )}
      <ErrorLine text={action.err} />
      <div className="flex justify-end gap-2">
        <button className={btnGhost} onClick={onClose}>Không hủy</button>
        <button className={`${btn} bg-rose-600 text-white hover:bg-rose-500`} disabled={action.pending || !reason.trim()} onClick={action.run}>
          {action.pending ? "Đang hủy…" : "Hủy hợp đồng"}
        </button>
      </div>
    </Modal>
  );
}

function ExtendDialog({ detail, lineId, onClose, onDone }: { detail: ContractDetail; lineId: number; onClose: () => void; onDone: () => void }) {
  const line = useMemo(() => detail.lines.find((l) => l.id === lineId)!, [detail, lineId]);
  const base = line.end ? new Date(line.end) : new Date();
  const [end, setEnd] = useState(toLocalInput(new Date(base.getTime() + 24 * 3600 * 1000)));
  const action = useAction(() => extendRental(lineId, fromLocalInput(end)!), "Đã gia hạn", onDone, onClose);
  return (
    <Modal title={`Gia hạn ${line.item_name}`} onClose={onClose}>
      <p className="text-sm text-slate-400">Hẹn trả hiện tại: {line.end ? fmtTime(line.end) : "tính giờ"}</p>
      <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className={input} aria-label="Hẹn trả mới" />
      <ErrorLine text={action.err} />
      <div className="flex justify-end gap-2">
        <button className={btnGhost} onClick={onClose}>Hủy</button>
        <button className={btnPrimary} disabled={action.pending} onClick={action.run}>{action.pending ? "Đang lưu…" : "Gia hạn"}</button>
      </div>
    </Modal>
  );
}
