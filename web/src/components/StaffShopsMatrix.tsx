"use client";

/**
 * Gán một nhân viên vào nhiều shop, mỗi shop một vai trò (M1, docs/multi-shop-design.md §1).
 * Chỉ chủ cửa hàng thấy. Mỗi dòng lưu riêng qua RPC set_staff_assignments (một transaction,
 * khóa hồ sơ nhân viên đó nên hai người cùng sửa không đè lẫn nhau).
 */
import React, { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Crown, Home, RotateCcw, Save } from "lucide-react";
import { activeContext, supabase, toApiError } from "@/utils/api";
import { BUSINESS_TYPE_LABELS, type BusinessType } from "@/utils/shop";
import { errorText, toast } from "@/components/Toaster";

type ShopRole = "staff" | "manager";
interface Shop { id: number; name: string; business_type: BusinessType; is_active: boolean }
interface StaffRow {
  id: string;
  username: string;
  full_name: string | null;
  is_active: boolean;
  home_branch_id: number | null;
  is_org_owner: boolean;
  is_self: boolean;
  assignments: { branch_id: number; role: string }[];
}
interface Draft { roles: Record<number, ShopRole | "">; home: number | null }

async function load() {
  const { branchId } = await activeContext();
  const { data, error } = await supabase.rpc("list_org_staff_assignments", { p_branch_id: branchId });
  if (error) toApiError(error);
  return data as { shops: Shop[]; users: StaffRow[] };
}

const toDraft = (u: StaffRow): Draft => ({
  roles: Object.fromEntries(u.assignments.map((a) => [a.branch_id, a.role as ShopRole])),
  home: u.home_branch_id,
});

export default function StaffShopsMatrix() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["staffShops"], queryFn: load });
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  const shops = useMemo(() => (data?.shops ?? []).filter((s) => s.is_active), [data]);
  const rows = data?.users ?? [];

  const draftOf = (u: StaffRow) => drafts[u.id] ?? toDraft(u);
  const dirty = (u: StaffRow) => Boolean(drafts[u.id]) && JSON.stringify(drafts[u.id]) !== JSON.stringify(toDraft(u));
  const setRole = (u: StaffRow, shopId: number, role: ShopRole | "") => {
    const d = draftOf(u);
    const roles = { ...d.roles, [shopId]: role };
    if (!role) delete roles[shopId];
    const assigned = Object.keys(roles).map(Number);
    // Shop mặc định luôn là một shop đang được gán
    const home = d.home && assigned.includes(d.home) ? d.home : assigned[0] ?? null;
    setDrafts((s) => ({ ...s, [u.id]: { roles, home } }));
  };

  const save = useMutation({
    mutationFn: async (u: StaffRow) => {
      const d = draftOf(u);
      const assignments = Object.entries(d.roles).filter(([, r]) => r).map(([b, r]) => ({ branch_id: Number(b), role: r }));
      const { data: res, error: err } = await supabase.rpc("set_staff_assignments", {
        p_user_id: u.id, p_assignments: assignments, p_home_branch_id: d.home,
      });
      if (err) toApiError(err);
      return res;
    },
    onSuccess: (_r, u) => {
      toast.success(`Đã lưu phân quyền ${u.full_name || u.username}`);
      setDrafts((s) => { const n = { ...s }; delete n[u.id]; return n; });
      qc.invalidateQueries({ queryKey: ["staffShops"] });
      qc.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (e) => toast.error(errorText(e, "Không lưu được phân quyền.")),
  });

  if (isLoading) return <p className="p-6 text-sm text-slate-500">Đang tải…</p>;
  if (error) return <p className="p-6 text-sm text-rose-500">{errorText(error, "Không tải được phân quyền.")}</p>;

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-400">
        Chọn vai trò của từng người ở từng shop. Có hiệu lực ngay, không cần đăng nhập lại.{" "}
        <Home className="inline h-3.5 w-3.5" /> = shop mở ra khi người đó đăng nhập.
      </p>
      <div className="overflow-x-auto rounded-2xl border border-slate-900">
        <table className="w-full min-w-[640px] border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-slate-900 bg-slate-950/40 font-semibold uppercase tracking-wider text-slate-500">
              <th className="sticky left-0 z-10 bg-slate-950 p-3">Nhân viên</th>
              {shops.map((s) => (
                <th key={s.id} className="min-w-[150px] p-3">
                  <span className="block normal-case text-slate-300">{s.name}</span>
                  <span className="block text-[10px] font-normal normal-case text-slate-500">{BUSINESS_TYPE_LABELS[s.business_type]}</span>
                </th>
              ))}
              <th className="p-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-900/60">
            {rows.map((u) => {
              const locked = u.is_org_owner || u.is_self;
              const d = draftOf(u);
              const assignedCount = Object.values(d.roles).filter(Boolean).length;
              return (
                <tr key={u.id} className={u.is_active ? "" : "opacity-50"}>
                  <td className="sticky left-0 z-10 bg-slate-950 p-3">
                    <p className="font-semibold text-slate-200">{u.full_name || u.username}</p>
                    <p className="text-[11px] text-slate-500">{u.username}{u.is_active ? "" : " · bị khóa"}</p>
                  </td>
                  {shops.map((s) => (
                    <td key={s.id} className="p-3">
                      {u.is_org_owner ? (
                        <span className="inline-flex items-center gap-1 text-emerald-400"><Crown className="h-3.5 w-3.5" /> Chủ</span>
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <select value={d.roles[s.id] ?? ""} disabled={locked}
                            onChange={(e) => setRole(u, s.id, e.target.value as ShopRole | "")}
                            aria-label={`Vai trò của ${u.username} ở ${s.name}`}
                            className={`rounded-lg border bg-slate-900 px-2 py-1.5 text-xs focus:border-indigo-500 focus:outline-none disabled:opacity-60 ${
                              d.roles[s.id] === "manager" ? "border-amber-500/40 text-amber-400"
                                : d.roles[s.id] === "staff" ? "border-indigo-500/40 text-indigo-400" : "border-slate-800 text-slate-500"}`}>
                            <option value="">— Không —</option>
                            <option value="staff">Nhân viên</option>
                            <option value="manager">Quản lý</option>
                          </select>
                          {d.roles[s.id] && (
                            <button type="button" disabled={locked || assignedCount < 2}
                              onClick={() => setDrafts((x) => ({ ...x, [u.id]: { ...d, home: s.id } }))}
                              aria-pressed={d.home === s.id} title="Shop mặc định khi đăng nhập"
                              className={`rounded p-1 ${d.home === s.id ? "text-indigo-400" : "text-slate-700 hover:text-slate-400"}`}>
                              <Home className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  ))}
                  <td className="p-3 text-right">
                    {u.is_self && !u.is_org_owner ? <span className="text-[11px] text-slate-500">Tài khoản của bạn</span> : null}
                    {dirty(u) && (
                      <div className="flex justify-end gap-1.5">
                        <button onClick={() => setDrafts((x) => { const n = { ...x }; delete n[u.id]; return n; })}
                          title="Hoàn tác" className="rounded-lg border border-slate-800 p-1.5 text-slate-400 hover:text-white">
                          <RotateCcw className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={() => save.mutate(u)} disabled={save.isPending || assignedCount === 0}
                          title={assignedCount === 0 ? "Phải còn ít nhất 1 shop — muốn cho nghỉ hẳn thì khóa tài khoản" : "Lưu"}
                          className="flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1.5 font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">
                          <Save className="h-3.5 w-3.5" /> Lưu
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
