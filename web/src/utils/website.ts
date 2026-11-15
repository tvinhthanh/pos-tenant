/**
 * Quản trị website shop & đơn online (docs/website-design.md). Mọi thao tác qua RPC;
 * cài đặt nhận đơn sửa thẳng bảng (RLS: quản lý của đúng shop).
 */
import { activeContext, supabase, toApiError } from "@/utils/api";
import type { CatalogItem, Fulfillment, Integrations, OpeningHours, Section, SiteTheme } from "@/utils/site";

async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) toApiError(error);
  return data as T;
}

export interface EditorPage {
  id: number;
  path: string;
  title: string;
  kind: string;
  sort_order: number;
  show_in_nav: boolean;
  draft_sections: Section[];
  published_sections: Section[] | null;
  seo: { title?: string; description?: string; og_image?: string; noindex?: boolean };
  published_at: string | null;
  updated_at: string;
}

export interface SiteTemplate {
  id: string;
  name: string;
  description: string;
  business_type: "fnb" | "retail" | "rental" | null;
  theme: SiteTheme;
}

export interface ShopDomain {
  id: number;
  domain: string;
  verify_token: string;
  status: "pending" | "active" | "failed";
  verified_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
}

export interface EditorData {
  branch: { id: number; name: string; business_type: "fnb" | "retail" | "rental"; subdomain: string | null; address: string | null; phone: string | null; logo_url: string | null };
  site: null | {
    branch_id: number;
    template_id: string;
    theme: Partial<SiteTheme>;
    integrations: Integrations;
    opening_hours: OpeningHours[];
    is_published: boolean;
    published_at: string | null;
    updated_at: string;
  };
  pages: EditorPage[];
  templates: SiteTemplate[];
  domains: ShopDomain[];
  limits: { max_site_pages: number; max_custom_domains: number };
}

export async function getEditor(): Promise<EditorData> {
  const { branchId } = await activeContext();
  return call<EditorData>("get_site_editor", { p_branch_id: branchId });
}

export async function initSite(templateId: string) {
  const { branchId } = await activeContext();
  return call("init_shop_site", { p_branch_id: branchId, p_template_id: templateId });
}

export async function setTemplate(templateId: string) {
  const { branchId } = await activeContext();
  return call("set_site_template", { p_branch_id: branchId, p_template_id: templateId });
}

export async function saveSettings(payload: { theme?: Partial<SiteTheme>; integrations?: Integrations; opening_hours?: OpeningHours[] }) {
  const { branchId } = await activeContext();
  return call("save_site_settings", { p_branch_id: branchId, p_payload: payload });
}

export async function savePage(page: {
  id?: number; path: string; title: string; kind?: string; show_in_nav: boolean; sections: Section[]; seo: EditorPage["seo"];
}) {
  const { branchId } = await activeContext();
  return call<{ id: number }>("save_site_page", { p_branch_id: branchId, p_payload: page });
}

export async function deletePage(id: number) {
  const { branchId } = await activeContext();
  return call("delete_site_page", { p_branch_id: branchId, p_page_id: id });
}

export async function reorderPages(ids: number[]) {
  const { branchId } = await activeContext();
  return call("reorder_site_pages", { p_branch_id: branchId, p_page_ids: ids });
}

export async function publishSite(publish = true) {
  const { branchId } = await activeContext();
  return call<{ published: boolean; pages: number }>("publish_site", { p_branch_id: branchId, p_publish: publish });
}

export async function setSubdomain(subdomain: string | null) {
  const { branchId } = await activeContext();
  return call("set_shop_subdomain", { p_branch_id: branchId, p_subdomain: subdomain });
}

export async function addDomain(domain: string) {
  const { branchId } = await activeContext();
  return call<ShopDomain>("add_shop_domain", { p_branch_id: branchId, p_domain: domain });
}

export const removeDomain = (id: number) => call("remove_shop_domain", { p_domain_id: id });

/** Kiểm DNS qua Edge Function verify-domain (service role ghi kết quả) */
export async function verifyDomain(id: number): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.functions.invoke("verify-domain", { body: { domain_id: id } });
  if (error) {
    let detail = error.message;
    try { detail = (await (error as any).context?.json())?.detail || detail; } catch { /* giữ thông báo gốc */ }
    throw new Error(detail);
  }
  return data;
}

/** Danh mục cho khung xem trước (website chưa xuất bản thì RPC công khai trả rỗng) */
export async function previewCatalog(businessType: string): Promise<CatalogItem[]> {
  const { branchId } = await activeContext();
  if (businessType === "rental") {
    const { data, error } = await supabase.from("rental_items")
      .select("id, name, category, description, deposit_amount, tracking_mode, rental_rates(price, rate_unit, is_default)")
      .eq("branch_id", branchId).eq("is_active", true).order("name");
    if (error) toApiError(error);
    return (data || []).map((i: any) => {
      const rate = [...(i.rental_rates || [])].sort((a: any, b: any) => Number(b.is_default) - Number(a.is_default))[0];
      return { id: i.id, name: i.name, category: i.category || "Cho thuê", description: i.description, price: rate?.price ?? null,
               rate_unit: rate?.rate_unit, deposit: i.deposit_amount, available: true, tracking_mode: i.tracking_mode };
    });
  }
  const { data, error } = await supabase.from("products")
    .select("id, name, category, price, image_url").eq("branch_id", branchId).eq("is_active", true).order("name");
  if (error) toApiError(error);
  return (data || []).map((p: any) => ({ ...p, available: true, sold_30d: 0 }));
}

/** Tải ảnh lên bucket sites: <org>/<branch>/<ngẫu nhiên>.<đuôi> */
export async function uploadSiteImage(file: File): Promise<string> {
  const { branchId, organizationId } = await activeContext();
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error("Chỉ nhận ảnh JPG, PNG hoặc WebP.");
  if (file.size > 5 * 1024 * 1024) throw new Error("Ảnh tối đa 5 MB.");
  const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const path = `${organizationId}/${branchId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from("sites").upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw new Error(error.message);
  return supabase.storage.from("sites").getPublicUrl(path).data.publicUrl;
}

// ---------------------------------------------------------------------------
// Đơn online
// ---------------------------------------------------------------------------
export type OnlineStatus = "pending" | "confirmed" | "auto_confirmed" | "rejected" | "expired" | "cancelled";

export interface OnlineRequest {
  id: number;
  code: string;
  kind: "order" | "reservation";
  status: OnlineStatus;
  contact_name: string;
  contact_phone: string;
  quoted_total: number;
  fulfillment: Fulfillment;
  requested_for: string | null;
  note: string | null;
  expires_at: string;
  converted_kind: "sales_order" | "rental_contract" | null;
  converted_ref: number | null;
  reject_reason: string | null;
  created_at: string;
  payload: { display?: { name: string; quantity: number; unit_price: number }[]; lines?: { name: string; quantity: number; start: string; end: string; deposit: number }[] };
}

export async function listOnlineRequests(scope: "open" | "all"): Promise<OnlineRequest[]> {
  const { branchId } = await activeContext();
  let q = supabase.from("online_requests").select("*").eq("branch_id", branchId).order("created_at", { ascending: false }).limit(100);
  if (scope === "open") q = q.in("status", ["pending", "confirmed", "auto_confirmed"]);
  const { data, error } = await q;
  if (error) toApiError(error);
  return (data || []) as OnlineRequest[];
}

export async function countPendingOnline(): Promise<number> {
  const { branchId } = await activeContext();
  const { count, error } = await supabase.from("online_requests").select("id", { count: "exact", head: true })
    .eq("branch_id", branchId).eq("status", "pending");
  if (error) return 0;
  return count ?? 0;
}

export const confirmOnline = (id: number) => call<{ converted_ref: number }>("confirm_online_request", { p_request_id: id });
export const rejectOnline = (id: number, reason: string) => call("reject_online_request", { p_request_id: id, p_reason: reason });
export const cancelOnlineOrder = (id: number, reason: string) => call("cancel_online_order", { p_request_id: id, p_reason: reason });

export async function completeDraft(orderId: number, method: string, amount: number) {
  const { branchId } = await activeContext();
  return call("complete_draft_order", {
    p_branch_id: branchId, p_order_id: orderId,
    p_payload: { status: "completed", payments: [{ method, amount }] },
  });
}

export async function draftStatus(orderIds: number[]): Promise<Record<number, { status: string; final_amount: number }>> {
  if (!orderIds.length) return {};
  const { data, error } = await supabase.from("sales_orders").select("id, status, final_amount").in("id", orderIds);
  if (error) toApiError(error);
  return Object.fromEntries((data || []).map((o: any) => [o.id, { status: o.status, final_amount: o.final_amount }]));
}

export interface OnlineSettings {
  branch_id: number;
  accept_orders: boolean;
  accept_reservations: boolean;
  fulfillments: Fulfillment[];
  auto_confirm_under: number | null;
  auto_confirm_requires_history: boolean;
  max_pending_per_customer: number;
  pending_expire_minutes: number;
  min_order_amount: number;
  notice: string | null;
}

export async function getOnlineSettings(): Promise<OnlineSettings | null> {
  const { branchId } = await activeContext();
  const { data, error } = await supabase.from("shop_online_settings").select("*").eq("branch_id", branchId).maybeSingle();
  if (error) toApiError(error);
  return data as OnlineSettings | null;
}

export async function saveOnlineSettings(s: Partial<OnlineSettings>) {
  const { branchId, organizationId } = await activeContext();
  const { error } = await supabase.from("shop_online_settings")
    .upsert({ ...s, branch_id: branchId, organization_id: organizationId, updated_at: new Date().toISOString() });
  if (error) toApiError(error);
}
