import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { normalizeVietnameseText } from "@/utils/text";
import { bySortOrder, mapOrderItemOptions } from "@/utils/productOptions";
import { newLocalId, type OfflineOrder } from "@/utils/offlineStore";
import {
  BUSINESS_TYPE_LABELS, POS_SERVICE_BY_TYPE, pickActiveShop,
  type BusinessType, type MyShop,
} from "@/utils/shop";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const INTERNAL_EMAIL_DOMAIN = process.env.NEXT_PUBLIC_INTERNAL_EMAIL_DOMAIN || "pos.local";
const LOGIN_EMAIL_ALIASES: Record<string, string> = {
  admin: process.env.NEXT_PUBLIC_ADMIN_EMAIL || process.env.NEXT_PUBLIC_SUPERADMIN_EMAIL || "superadmin@pos.local",
  owner: process.env.NEXT_PUBLIC_OWNER_EMAIL || "owner@pos.local",
  staff: process.env.NEXT_PUBLIC_STAFF_EMAIL || "staff@pos.local",
  superadmin: process.env.NEXT_PUBLIC_SUPERADMIN_EMAIL || "superadmin@pos.local",
};

export const API_URL = SUPABASE_URL;

let supabaseClient: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (!SUPABASE_URL) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL. Set it in Vercel Environment Variables and redeploy.");
  }

  if (!SUPABASE_ANON_KEY) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_ANON_KEY. Set it in Vercel Environment Variables and redeploy.");
  }

  supabaseClient ??= createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });

  return supabaseClient;
}

export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, property, receiver) {
    const client = getSupabase();
    const value = Reflect.get(client, property, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

type ApiResponse<T = any> = { data: T };
type ApiConfig = {
  params?: Record<string, string | number | boolean | null | undefined>;
  responseType?: string;
};

type StoreRow = {
  id: number;
  name: string;
  is_active: boolean;
  subscription_plans?: { name?: string | null } | Array<{ name?: string | null }> | null;
  branches?: Array<{
    id: number;
    name: string;
    address: string | null;
    phone: string | null;
    is_active: boolean;
  }>;
  subscriptions?: Array<{
    plan: string;
    expires_at: string;
    status: string;
  }>;
  profiles?: Array<{
    id: string;
    is_active: boolean;
  }>;
};

function asResponse<T>(data: T): ApiResponse<T> {
  return { data };
}

function normalizeEmail(usernameOrEmail: string): string {
  const value = usernameOrEmail.trim().toLowerCase();
  if (LOGIN_EMAIL_ALIASES[value]) return LOGIN_EMAIL_ALIASES[value];
  return value.includes("@") ? value : `${value}@${INTERNAL_EMAIL_DOMAIN}`;
}

/**
 * Ô đăng nhập nhận username hoặc email. Có "@" → dùng luôn làm email. Không có →
 * tra profiles.username (RPC chỉ trả email khi mật khẩu đúng); không thấy thì quay
 * về cách cũ (alias demo / <username>@<domain nội bộ>).
 */
async function resolveLoginEmail(login: string, password: string): Promise<string> {
  const value = login.trim().toLowerCase();
  if (value.includes("@")) return value;
  if (value && password) {
    const { data, error } = await getSupabase().rpc("resolve_login_email", { p_login: value, p_password: password });
    if (!error && typeof data === "string" && data) return data;
  }
  return normalizeEmail(value);
}

function cleanPath(input: string, config?: ApiConfig): { path: string; query: URLSearchParams } {
  const url = new URL(input, "http://local");
  Object.entries(config?.params || {}).forEach(([key, value]) => {
    if (value !== null && value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  });
  return { path: url.pathname, query: url.searchParams };
}

export function toApiError(error: any): never {
  const message = error?.message || error?.details || "Supabase request failed";
  const wrapped: any = new Error(message);
  wrapped.response = { data: { detail: message }, status: error?.code === "42501" ? 403 : 400 };
  // Mã lỗi Postgres/PostgREST (VD 22023, 42501). Không có mã = lỗi mạng/fetch.
  wrapped.code = error?.code || null;
  throw wrapped;
}

// Supabase Auth trả lỗi tiếng Anh ("Invalid login credentials"). Đổi theo mã lỗi
// sang tiếng Việt. Sai tên đăng nhập và sai mật khẩu dùng chung một câu để
// không lộ tài khoản nào có thật.
function loginErrorMessage(error: any): string {
  const code = String(error?.code || "");
  if (code === "invalid_credentials" || /invalid login credentials/i.test(error?.message || "")) {
    return "Tên đăng nhập hoặc mật khẩu không đúng.";
  }
  if (code === "email_not_confirmed") return "Tài khoản chưa được xác nhận email.";
  if (code === "user_banned") return "Tài khoản đã bị khóa. Liên hệ chủ quán để mở lại.";
  if (code.startsWith("over_") || error?.status === 429) {
    return "Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau ít phút.";
  }
  if (!error?.status || error?.name === "AuthRetryableFetchError") {
    return "Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.";
  }
  return "Đăng nhập thất bại. Vui lòng thử lại.";
}

function throwApiError(message: string, status = 400): never {
  const error: any = new Error(message);
  error.response = { data: { detail: message }, status };
  throw error;
}

// Edge Function trả lỗi qua body {detail}. supabase-js gói nó trong
// FunctionsHttpError.context nên phải bóc ra, nếu không người dùng chỉ thấy
// "Edge Function returned a non-2xx status code".
async function invokeFunction(name: string, body: Record<string, unknown>): Promise<{ data: any; error: any }> {
  const { data, error } = await getSupabase().functions.invoke(name, { body });
  if (!error) return { data, error: null };

  let detail = error.message || "Edge Function request failed";
  const context = (error as any).context;
  if (context && typeof context.json === "function") {
    try {
      const parsed = await context.json();
      if (parsed?.detail) detail = parsed.detail;
    } catch {
      // giữ nguyên message gốc
    }
  }
  return { data: null, error: { message: detail } };
}

function unsupportedFeature(feature: string): never {
  const error: any = new Error(`${feature} is not implemented in the Supabase adapter.`);
  error.response = { data: { detail: error.message }, status: 501 };
  throw error;
}

const ORDER_ITEMS_SELECT = "sales_order_items(*, products(name, price), sales_order_item_options(*))";

function mapOrderItem(item: any) {
  const { sales_order_item_options, ...rest } = item;
  return {
    ...rest,
    product_name: normalizeVietnameseText(item.product_name_snapshot || item.products?.name || item.name || "Sản phẩm"),
    price: Number(item.unit_price_snapshot ?? item.products?.price ?? 0),
    quantity: Number(item.quantity || 0),
    options: mapOrderItemOptions(sales_order_item_options),
  };
}

/** Dòng món gửi lên RPC: giá do DB tính, client chỉ gửi món + số lượng + tùy chọn. */
function toOrderLinePayload(item: any) {
  return {
    product_id: item.product_id,
    quantity: item.quantity,
    option_ids: item.option_ids || [],
    // Món tặng: DB tự để giá 0đ và ghi lý do + người tặng
    ...(item.comp ? { comp: true, comp_reason: item.comp_reason } : {}),
  };
}

function mapStore(row: StoreRow) {
  const branch = row.branches?.[0];
  const plan = Array.isArray(row.subscription_plans) ? row.subscription_plans[0] : row.subscription_plans;
  const activeSubscription =
    row.subscriptions?.find((subscription) => subscription.status === "active") ||
    row.subscriptions?.[0];

  return {
    id: row.id,
    name: row.name,
    address: branch?.address || null,
    phone: branch?.phone || null,
    subscription_tier: activeSubscription?.plan || plan?.name || "free",
    subscription_expires_at: activeSubscription?.expires_at || null,
    is_active: Boolean(row.is_active && (branch?.is_active ?? true)),
    users_count: row.profiles?.filter((profile) => profile.is_active).length || 0,
  };
}

async function requireProfile() {
  const { data: userData, error: userError } = await getSupabase().auth.getUser();
  if (userError) toApiError(userError);
  if (!userData.user) {
    const error: any = new Error("Not authenticated");
    error.response = { status: 401, data: { detail: "Not authenticated" } };
    throw error;
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userData.user.id)
    .single();

  if (error) toApiError(error);
  if (!data.is_active) throwApiError("Tài khoản đã bị khóa.", 403);

  if (data.role === "superadmin") {
    return { ...data, home_role: data.role, shops: [] as MyShop[], business_type: null, shop_name: null, is_org_owner: false };
  }

  // Multi-shop: vai trò hiển thị là vai trò ở SHOP ĐANG DÙNG (DB vẫn tự kiểm
  // quyền theo user_assignments ở mọi RPC / policy).
  const shops = await loadMyShops(userData.user.id);
  if (shops.length === 0) {
    throwApiError("Tài khoản chưa được gán vào shop nào. Liên hệ chủ cửa hàng.", 403);
  }
  const shop = pickActiveShop(shops, data.branch_id ?? null)!;
  if (!shop.is_active) {
    throwApiError("Shop đã bị khóa. Vui lòng liên hệ Admin tổng để được hỗ trợ.", 403);
  }

  const service = POS_SERVICE_BY_TYPE[shop.business_type];
  const { data: subscription, error: subscriptionError } = await getSupabase()
    .from("subscriptions")
    .select("id")
    .eq("branch_id", shop.branch_id)
    .eq("service_code", service)
    .eq("status", "active")
    .gt("expires_at", new Date().toISOString())
    .limit(1)
    .maybeSingle();
  if (subscriptionError) toApiError(subscriptionError);
  if (!subscription) {
    throwApiError(`Thuê bao ${BUSINESS_TYPE_LABELS[shop.business_type]} của shop đã hết hạn hoặc chưa được kích hoạt.`, 403);
  }

  return {
    ...data,
    home_role: data.role,
    role: shop.role,
    organization_id: shop.organization_id,
    branch_id: shop.branch_id,
    business_type: shop.business_type,
    shop_name: shop.name,
    shops,
    // Owner toàn tổ chức (tạo shop). DB kiểm lại trong create_shop.
    is_org_owner: data.role === "owner" && shop.role === "owner",
  };
}

// my_shops() được gọi ở mọi request qua requireProfile → nhớ ngắn hạn.
let shopsCache: { userId: string; at: number; shops: MyShop[] } | null = null;
const SHOPS_CACHE_MS = 15_000;

async function loadMyShops(userId: string): Promise<MyShop[]> {
  if (shopsCache && shopsCache.userId === userId && Date.now() - shopsCache.at < SHOPS_CACHE_MS) {
    return shopsCache.shops;
  }
  const { data, error } = await getSupabase().rpc("my_shops");
  if (error) toApiError(error);
  const shops = (data || []) as MyShop[];
  shopsCache = { userId, at: Date.now(), shops };
  return shops;
}

export function invalidateShopsCache() {
  shopsCache = null;
}

export async function createShop(payload: {
  name: string;
  business_type: BusinessType;
  subdomain?: string | null;
  address?: string | null;
  phone?: string | null;
}) {
  const { data, error } = await getSupabase().rpc("create_shop", {
    p_name: payload.name,
    p_business_type: payload.business_type,
    p_subdomain: payload.subdomain || null,
    p_address: payload.address || null,
    p_phone: payload.phone || null,
  });
  if (error) toApiError(error);
  invalidateShopsCache();
  return data as { branch_id: number; name: string; business_type: BusinessType; subdomain: string | null };
}

export async function selfSignup(payload: {
  email: string;
  password: string;
  full_name?: string;
  shop_name: string;
  business_type: BusinessType;
  subdomain?: string | null;
  captcha_token?: string;
}) {
  const { data, error } = await invokeFunction("self-signup", payload);
  if (error) throwApiError(error.message || "Đăng ký thất bại.", 400);
  return data as { user_id: string; branch_id: number; email_confirmation_required: boolean };
}

export async function activeContext() {
  const profile = await requireProfile();
  const branchId = profile.branch_id;
  const organizationId = profile.organization_id;
  if (!branchId || !organizationId) throw new Error("Profile missing organization_id/branch_id");
  return { profile, branchId, organizationId };
}

async function getCashBalance(branchId: number) {
  const { data, error } = await supabase
    .from("cashbook")
    .select("balance")
    .eq("branch_id", branchId)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) toApiError(error);
  return { balance: Number(data?.balance || 0) };
}

// Ngày trong query string là ngày địa phương (YYYY-MM-DD). Khoảng lọc phải phủ
// trọn ngày kết thúc, nếu không đơn bán buổi chiều sẽ rơi ra ngoài báo cáo.
function toRangeStart(value: string | null): string | null {
  return value ? new Date(`${value}T00:00:00`).toISOString() : null;
}

function toRangeEnd(value: string | null): string | null {
  return value ? new Date(`${value}T23:59:59.999`).toISOString() : null;
}

function monthLabel(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}`;
}

async function getFinancialReport(branchId: number, from: string | null, to: string | null) {
  const { data, error } = await getSupabase().rpc("get_financial_report", {
    p_branch_id: branchId,
    p_from: from,
    p_to: to,
  });
  if (error) toApiError(error);

  const revenue = Number(data?.revenue || 0);
  const ordersCount = Number(data?.orders_count || 0);

  return {
    ...data,
    revenue,
    cogs: Number(data?.cogs || 0),
    gross_profit: Number(data?.gross_profit || 0),
    orders_count: ordersCount,
    estimated_tax: Number(data?.estimated_tax || 0),
    total_revenue: revenue,
    total_expenses: Number(data?.total_expenses || 0),
    net_profit: Number(data?.net_profit || 0),
    total_orders: ordersCount,
    average_order_value: Number(data?.average_order_value || 0),
  };
}

async function getSuperStats(orgId: number | null) {
  const orgQuery = getSupabase()
    .from("organizations")
    .select("id, name, is_active, subscription_plans(name)");
  if (orgId) orgQuery.eq("id", orgId);
  const { data: orgs, error: orgsError } = await orgQuery.order("created_at", { ascending: false });
  if (orgsError) toApiError(orgsError);

  const orgIds = (orgs || []).map((org: any) => org.id);
  if (orgId && orgIds.length === 0) {
    return {
      scope: "organization",
      total_orgs: 0,
      total_orgs_active: 0,
      total_branches: 0,
      total_users: 0,
      total_orders: 0,
      total_revenue: 0,
      active_subscriptions: 0,
      monthly_revenue: [],
      org_stats: [],
    };
  }

  const [branchesResult, usersResult, ordersResult, subscriptionsResult, refundsResult] = await Promise.all([
    getSupabase().from("branches").select("id, organization_id").in("organization_id", orgIds.length ? orgIds : [-1]),
    getSupabase().from("profiles").select("id, organization_id, role").in("organization_id", orgIds.length ? orgIds : [-1]),
    getSupabase()
      .from("sales_orders")
      .select("id, organization_id, final_amount, status, date")
      .in("organization_id", orgIds.length ? orgIds : [-1])
      .in("status", ["completed", "partially_refunded", "refunded"]),
    getSupabase()
      .from("subscriptions")
      .select("id, organization_id")
      .in("organization_id", orgIds.length ? orgIds : [-1])
      .eq("status", "active")
      .gt("expires_at", new Date().toISOString()),
    getSupabase()
      .from("refunds")
      .select("order_id, amount")
      .in("organization_id", orgIds.length ? orgIds : [-1]),
  ]);

  if (branchesResult.error) toApiError(branchesResult.error);
  if (usersResult.error) toApiError(usersResult.error);
  if (ordersResult.error) toApiError(ordersResult.error);
  if (subscriptionsResult.error) toApiError(subscriptionsResult.error);
  if (refundsResult.error) toApiError(refundsResult.error);

  const branches = branchesResult.data || [];
  const users = (usersResult.data || []).filter((user: any) => user.role !== "superadmin");
  const activeSubscriptions = subscriptionsResult.data || [];
  // Doanh thu thực của đơn = thành tiền − tiền đã hoàn. Đơn hoàn hết tính 0,
  // hoàn một phần chỉ tính phần còn lại (cùng cách báo cáo của shop).
  const refundedByOrder = new Map<number, number>();
  (refundsResult.data || []).forEach((refund: any) => {
    refundedByOrder.set(refund.order_id, (refundedByOrder.get(refund.order_id) || 0) + Number(refund.amount || 0));
  });
  const orders = (ordersResult.data || []).map((order: any) => ({
    ...order,
    net_amount: Math.max(0, Number(order.final_amount || 0) - (refundedByOrder.get(order.id) || 0)),
  }));
  const totalRevenue = orders.reduce((sum: number, order: any) => sum + order.net_amount, 0);

  const monthlyRevenueMap = new Map<string, number>();
  for (let i = 5; i >= 0; i -= 1) {
    const date = new Date();
    date.setMonth(date.getMonth() - i, 1);
    monthlyRevenueMap.set(monthLabel(date), 0);
  }
  orders.forEach((order: any) => {
    if (!order.date) return;
    const label = monthLabel(new Date(order.date));
    if (monthlyRevenueMap.has(label)) {
      monthlyRevenueMap.set(label, (monthlyRevenueMap.get(label) || 0) + order.net_amount);
    }
  });

  return {
    scope: orgId ? "organization" : "system",
    total_orgs: orgs?.length || 0,
    total_orgs_active: (orgs || []).filter((org: any) => org.is_active).length,
    total_branches: branches.length,
    total_users: users.length,
    total_orders: orders.length,
    total_revenue: totalRevenue,
    active_subscriptions: activeSubscriptions.length,
    monthly_revenue: Array.from(monthlyRevenueMap.entries()).map(([label, revenue]) => ({ label, revenue })),
    org_stats: (orgs || []).map((org: any) => ({
      id: org.id,
      name: org.name,
      is_active: org.is_active,
      plan: org.subscription_plans?.name || org.subscription_plans?.[0]?.name || "—",
      users: users.filter((user: any) => user.organization_id === org.id).length,
      orders: orders.filter((order: any) => order.organization_id === org.id).length,
      revenue: orders
        .filter((order: any) => order.organization_id === org.id)
        .reduce((sum: number, order: any) => sum + order.net_amount, 0),
    })),
  };
}

async function getSaasMetrics() {
  const stats = await getSuperStats(null);
  return {
    mrr: 0,
    total_organizations: stats.total_orgs,
    active_organizations: stats.total_orgs_active,
    churn_rate_percent: stats.total_orgs > 0
      ? Number((((stats.total_orgs - stats.total_orgs_active) / stats.total_orgs) * 100).toFixed(2))
      : 0,
    ltv: stats.total_orgs_active > 0 ? Math.round(stats.total_revenue / stats.total_orgs_active) : 0,
  };
}

async function getSuperAuditLogs(query: URLSearchParams) {
  const limit = Number(query.get("limit") || 50);
  const offset = Number(query.get("offset") || 0);
  const orgId = query.get("org_id");
  const baseSelect = "id, action, description, created_at, ip_address, organization_id, branch_id, profiles(username, role), organizations(name), branches(name)";

  let rowsQuery = getSupabase()
    .from("audit_logs")
    .select(baseSelect)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  let countQuery = getSupabase()
    .from("audit_logs")
    .select("id", { count: "exact", head: true });

  if (orgId) {
    rowsQuery = rowsQuery.eq("organization_id", Number(orgId));
    countQuery = countQuery.eq("organization_id", Number(orgId));
  }

  const [{ data, error }, { count, error: countError }] = await Promise.all([rowsQuery, countQuery]);
  if (error) toApiError(error);
  if (countError) toApiError(countError);

  return {
    total: count || 0,
    items: (data || []).map((row: any) => {
      const actor = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
      const organization = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
      const branch = Array.isArray(row.branches) ? row.branches[0] : row.branches;
      return {
        id: row.id,
        action: row.action,
        description: row.description,
        created_at: row.created_at,
        ip_address: row.ip_address,
        actor: actor?.username || "system",
        actor_role: actor?.role || null,
        org_id: row.organization_id,
        org_name: organization?.name || null,
        branch_id: row.branch_id,
        branch_name: branch?.name || null,
      };
    }),
  };
}

async function get(pathWithQuery: string, config?: ApiConfig): Promise<ApiResponse> {
  const { path, query } = cleanPath(pathWithQuery, config);

  if (path === "/api/v1/auth/me") {
    return asResponse(await requireProfile());
  }

  if (path === "/api/v1/auth/super/organizations") {
    const { data, error } = await getSupabase().from("organizations").select("*").order("created_at", { ascending: false });
    if (error) toApiError(error);
    return asResponse(data || []);
  }

  if (path === "/api/v1/auth/super/stores") {
    const { data, error } = await getSupabase()
      .from("organizations")
      .select(`
        id,
        name,
        is_active,
        subscription_plans(name),
        branches(id, name, address, phone, is_active),
        subscriptions(plan, expires_at, status),
        profiles(id, is_active)
      `)
      .order("created_at", { ascending: false });
    if (error) toApiError(error);
    return asResponse(((data || []) as StoreRow[]).map(mapStore));
  }

  if (path.startsWith("/api/v1/auth/super/audit-logs")) {
    return asResponse(await getSuperAuditLogs(query));
  }

  if (path === "/api/v1/auth/super/stats") {
    return asResponse(await getSuperStats(query.get("org_id") ? Number(query.get("org_id")) : null));
  }

  if (path === "/api/v1/reports/saas-metrics") {
    return asResponse(await getSaasMetrics());
  }

  const { branchId, organizationId } = await activeContext();

  if (path === "/api/v1/pos/products") {
    const { data, error } = await getSupabase()
      .from("products")
      .select(`*,
        product_recipes(id, ingredient_id, quantity, ingredients(name, unit, cost_price)),
        product_option_groups(option_groups(id, name, min_select, max_select, sort_order, is_active,
          option_items(id, name, price_delta, is_default, sort_order, is_active)))`)
      .eq("branch_id", branchId)
      .eq("is_active", true)
      .order("name");
    if (error) toApiError(error);
    // Màn hình Kho cần recipe + giá vốn; bảng products không có 2 trường này nên
    // phải dựng từ product_recipes.
    return asResponse((data || []).map(({ product_option_groups, ...product }: any) => {
      const option_groups = (product_option_groups || [])
        .map((link: any) => link.option_groups)
        .filter((group: any) => group?.is_active)
        .map((group: any) => ({
          ...group,
          option_items: (group.option_items || [])
            .filter((item: any) => item.is_active)
            .sort(bySortOrder),
        }))
        .filter((group: any) => group.option_items.length > 0)
        .sort(bySortOrder);
      const recipe = (product.product_recipes || []).map((row: any) => ({
        id: row.id,
        ingredient_id: row.ingredient_id,
        quantity: Number(row.quantity || 0),
        ingredient_name: row.ingredients?.name || "Nguyên liệu",
        ingredient_unit: row.ingredients?.unit || "",
        ingredient_cost_price: Number(row.ingredients?.cost_price || 0),
      }));
      return {
        ...product,
        recipe,
        option_groups,
        cost_price: Math.round(
          recipe.reduce((sum: number, row: any) => sum + row.quantity * row.ingredient_cost_price, 0)
        ),
      };
    }));
  }

  if (path === "/api/v1/menu/option-groups") {
    const { data, error } = await getSupabase()
      .from("option_groups")
      .select(`id, name, min_select, max_select, sort_order,
        option_items(id, name, price_delta, is_default, sort_order, is_active,
          option_item_recipes(ingredient_id, quantity)),
        product_option_groups(product_id, products(is_active))`)
      .eq("branch_id", branchId)
      .eq("is_active", true);
    if (error) toApiError(error);
    return asResponse((data || []).sort(bySortOrder).map(({ product_option_groups, ...group }: any) => ({
      ...group,
      // Chỉ món đang bán — món đã ngừng không hiện trong form nên không bỏ tích được
      product_ids: (product_option_groups || [])
        .filter((link: any) => link.products?.is_active)
        .map((link: any) => link.product_id),
      option_items: (group.option_items || [])
        .filter((item: any) => item.is_active)
        .sort(bySortOrder)
        .map(({ option_item_recipes, ...item }: any) => ({
          ...item,
          recipe: (option_item_recipes || []).map((row: any) => ({
            ingredient_id: row.ingredient_id,
            quantity: Number(row.quantity || 0),
          })),
        })),
    })));
  }

  if (path === "/api/v1/inventory/ingredients") {
    const { data, error } = await getSupabase().from("ingredients").select("*").eq("branch_id", branchId).eq("is_active", true).order("name");
    if (error) toApiError(error);
    return asResponse(data || []);
  }

  if (path === "/api/v1/suppliers") {
    const { data, error } = await getSupabase().from("suppliers").select("*").eq("branch_id", branchId).eq("is_active", true).order("name");
    if (error) toApiError(error);
    return asResponse(data || []);
  }

  if (path === "/api/v1/pos/orders") {
    const limit = Number(query.get("limit") || 50);
    const { data, error } = await supabase
      .from("sales_orders")
      .select(`*, ${ORDER_ITEMS_SELECT}`)
      .eq("branch_id", branchId)
      .order("date", { ascending: false })
      .limit(limit);
    if (error) toApiError(error);
    return asResponse((data || []).map((order: any) => ({
      ...order,
      customer_name: normalizeVietnameseText(order.customer_name),
      payment_method: normalizeVietnameseText(order.payment_method),
      items: (order.sales_order_items || []).map(mapOrderItem),
    })));
  }

  const openTableOrderMatch = path.match(/^\/api\/v1\/pos\/tables\/(\d+)\/open-order$/);
  if (openTableOrderMatch) {
    const tableId = Number(openTableOrderMatch[1]);
    const { data, error } = await supabase
      .from("sales_orders")
      .select(`*, customers(id,name,phone,points), vouchers(code,value,discount_type,min_order_value), ${ORDER_ITEMS_SELECT}`)
      .eq("branch_id", branchId)
      .eq("table_id", tableId)
      .eq("status", "draft")
      .order("date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) toApiError(error);
    if (!data) return asResponse(null);
    return asResponse({
      ...data,
      customer_name: normalizeVietnameseText(data.customer_name),
      customer: data.customers ? {
        ...data.customers,
        name: normalizeVietnameseText(data.customers.name),
      } : null,
      voucher: data.vouchers || null,
      items: (data.sales_order_items || []).map(mapOrderItem),
    });
  }

  if (path === "/api/v1/tables/areas") {
    const { data, error } = await getSupabase().from("areas").select("*").eq("branch_id", branchId).order("name");
    if (error) toApiError(error);
    return asResponse(data || []);
  }

  if (path === "/api/v1/tables/tables") {
    const { data, error } = await getSupabase().from("tables").select("*").eq("branch_id", branchId).eq("is_active", true);
    if (error) toApiError(error);
    return asResponse((data || []).sort((a: any, b: any) =>
      a.name.localeCompare(b.name, "vi", { numeric: true, sensitivity: "base" })
    ));
  }

  if (path === "/api/v1/pos/customers") {
    const { data, error } = await getSupabase().from("customers").select("*").eq("branch_id", branchId).order("created_at", { ascending: false });
    if (error) toApiError(error);
    return asResponse(data || []);
  }

  if (path === "/api/v1/pos/customers/search") {
    const phone = query.get("phone") || "";
    const { data, error } = await getSupabase().from("customers").select("*").eq("branch_id", branchId).eq("phone", phone).maybeSingle();
    if (error) toApiError(error);
    return asResponse(data);
  }

  if (path.startsWith("/api/v1/pos/vouchers/")) {
    const code = decodeURIComponent(path.split("/").pop() || "");
    const { data, error } = await getSupabase().from("vouchers").select("*").eq("branch_id", branchId).ilike("code", code).eq("is_active", true).maybeSingle();
    if (error) toApiError(error);
    return asResponse(data);
  }

  if (path === "/api/v1/cashbook") {
    const { data, error } = await getSupabase().from("cashbook").select("*").eq("branch_id", branchId).order("date", { ascending: false }).limit(100);
    if (error) toApiError(error);
    return asResponse(data || []);
  }

  if (path === "/api/v1/cashbook/balance") {
    return asResponse(await getCashBalance(branchId));
  }

  if (path === "/api/v1/expenses") {
    const { data, error } = await getSupabase().from("expenses").select("*").eq("branch_id", branchId).order("date", { ascending: false });
    if (error) toApiError(error);
    return asResponse(data || []);
  }

  if (path === "/api/v1/expenses/categories") {
    const { data, error } = await getSupabase().from("expense_categories").select("*").eq("branch_id", branchId).order("name");
    if (error) toApiError(error);
    return asResponse(data || []);
  }

  if (path === "/api/v1/shifts") {
    const { data, error } = await getSupabase().from("shifts").select("*").eq("branch_id", branchId).order("id", { ascending: false });
    if (error) toApiError(error);
    return asResponse(data || []);
  }

  if (path === "/api/v1/shifts/current") {
    const { data, error } = await getSupabase().from("shifts").select("*").eq("branch_id", branchId).eq("status", "open").order("id", { ascending: false }).limit(1).maybeSingle();
    if (error) toApiError(error);
    return asResponse(data);
  }

  const reconciliationMatch = path.match(/^\/api\/v1\/shifts\/(\d+)\/reconciliation$/);
  if (reconciliationMatch) {
    const { data, error } = await getSupabase().rpc("get_shift_reconciliation", {
      p_shift_id: Number(reconciliationMatch[1]),
    });
    if (error) toApiError(error);
    return asResponse(data);
  }

  if (path === "/api/v1/reports/financial") {
    return asResponse(await getFinancialReport(
      branchId,
      toRangeStart(query.get("start_date")),
      toRangeEnd(query.get("end_date")),
    ));
  }

  if (path === "/api/v1/reports/sales-breakdown") {
    const { data, error } = await getSupabase().rpc("get_sales_breakdown", {
      p_branch_id: branchId,
      p_from: toRangeStart(query.get("start_date")),
      p_to: toRangeEnd(query.get("end_date")),
    });
    if (error) toApiError(error);
    const n = (v: unknown) => Number(v || 0);
    return asResponse({
      totals: {
        orders: n(data?.totals?.orders),
        quantity: n(data?.totals?.quantity),
        revenue: n(data?.totals?.revenue),
        cost: n(data?.totals?.cost),
        comp_quantity: n(data?.totals?.comp_quantity),
        comp_value: n(data?.totals?.comp_value),
      },
      comps: (data?.comps || []).map((r: any) => ({
        sold_at: String(r.sold_at),
        order_id: n(r.order_id),
        product_name: normalizeVietnameseText(r.product_name),
        options: r.options ? normalizeVietnameseText(r.options) : "",
        quantity: n(r.quantity),
        value: n(r.value),
        reason: normalizeVietnameseText(r.reason || ""),
        given_by: normalizeVietnameseText(r.given_by || ""),
      })),
      products: (data?.products || []).map((r: any) => ({
        ...r,
        product_name: normalizeVietnameseText(r.product_name),
        category: normalizeVietnameseText(r.category),
        quantity: n(r.quantity), revenue: n(r.revenue), cost: n(r.cost), orders: n(r.orders),
      })),
      categories: (data?.categories || []).map((r: any) => ({
        ...r, category: normalizeVietnameseText(r.category), quantity: n(r.quantity), revenue: n(r.revenue),
      })),
      options: (data?.options || []).map((r: any) => ({
        ...r,
        group_name: normalizeVietnameseText(r.group_name),
        option_name: normalizeVietnameseText(r.option_name),
        quantity: n(r.quantity), extra_revenue: n(r.extra_revenue),
      })),
      days: (data?.days || []).map((r: any) => ({
        day: String(r.day),
        orders: n(r.orders), revenue: n(r.revenue), discount: n(r.discount), quantity: n(r.quantity),
        top_product: r.top_product ? normalizeVietnameseText(r.top_product) : null,
        top_quantity: n(r.top_quantity),
      })),
      product_options: (data?.product_options || []).map((r: any) => ({
        ...r,
        product_name: normalizeVietnameseText(r.product_name),
        group_name: normalizeVietnameseText(r.group_name),
        option_name: normalizeVietnameseText(r.option_name),
        quantity: n(r.quantity), extra_revenue: n(r.extra_revenue),
      })),
    });
  }

  if (path === "/api/v1/adjustments") {
    const { data, error } = await getSupabase().from("inventory_adjustments").select("*").eq("branch_id", branchId).order("created_at", { ascending: false });
    if (error) toApiError(error);
    return asResponse(data || []);
  }

  if (path === "/api/v1/marketing/campaigns") {
    const { data, error } = await getSupabase().from("marketing_campaigns").select("*").eq("branch_id", branchId).order("created_at", { ascending: false });
    if (error) toApiError(error);
    return asResponse(data || []);
  }

  if (path === "/api/v1/auth/users") {
    const { data, error } = await getSupabase().rpc("list_branch_users", { p_branch_id: branchId });
    if (error) toApiError(error);
    return asResponse((data || []).map((user: any) => ({
      ...user,
      username: normalizeVietnameseText(user.username),
      full_name: normalizeVietnameseText(user.full_name),
    })));
  }

  if (path === "/api/v1/auth/users/payroll") {
    const { data, error } = await getSupabase().rpc("get_branch_payroll", {
      p_branch_id: branchId,
      p_from: toRangeStart(query.get("start_date")),
      p_to: toRangeEnd(query.get("end_date")),
    });
    if (error) toApiError(error);
    return asResponse((data || []).map((row: any) => ({
      ...row,
      username: normalizeVietnameseText(row.username),
      full_name: normalizeVietnameseText(row.full_name),
      hourly_rate: Number(row.hourly_rate || 0),
      total_shifts: Number(row.total_shifts || 0),
      total_hours: Number(row.total_hours || 0),
      total_salary: Number(row.total_salary || 0),
    })));
  }

  unsupportedFeature(`GET ${pathWithQuery}`);
}

async function post(path: string, payload?: any, _config?: ApiConfig): Promise<ApiResponse> {
  if (path === "/api/v1/auth/login") {
    const username = payload instanceof URLSearchParams ? payload.get("username") : payload?.username;
    const password = payload instanceof URLSearchParams ? payload.get("password") : payload?.password;
    const { data, error } = await getSupabase().auth.signInWithPassword({
      email: await resolveLoginEmail(username || "", password || ""),
      password: password || "",
    });
    if (error) throwApiError(loginErrorMessage(error), error.status === 429 ? 429 : 400);
    if (typeof window !== "undefined") localStorage.setItem("melio_token", data.session?.access_token || "");
    return asResponse({ access_token: data.session?.access_token, user: data.user });
  }

  if (path === "/api/v1/auth/super/stores") {
    const { data, error } = await invokeFunction("manage-branch-user", {
      action: "create_store",
      name: payload?.name,
      address: payload?.address || null,
      phone: payload?.phone || null,
      subscription_tier: payload?.subscription_tier || "free",
      subscription_expires_at: payload?.subscription_expires_at || null,
      owner_username: payload?.owner_username,
      owner_password: payload?.owner_password,
      owner_full_name: payload?.owner_full_name || null,
    });
    if (error) toApiError(error);
    return asResponse(data);
  }

  const { branchId, organizationId, profile } = await activeContext();

  if (path === "/api/v1/shifts/open") {
    const { data, error } = await getSupabase().rpc("open_shift", {
      p_branch_id: branchId,
      p_opening_balance: payload?.opening_balance || 0,
      p_notes: payload?.notes || null,
    });
    if (error) toApiError(error);
    return asResponse(data);
  }

  if (path === "/api/v1/shifts/close") {
    const { data, error } = await getSupabase().rpc("close_shift", {
      p_branch_id: branchId,
      p_closing_balance: payload?.closing_balance || 0,
      p_notes: payload?.notes || null,
    });
    if (error) toApiError(error);
    return asResponse(data);
  }

  if (path === "/api/v1/pos/orders") {
    const status = payload?.status || "completed";
    const total = Number(payload?.total_amount ?? payload?.final_amount ?? 0);
    const items = (payload?.items || []).map(toOrderLinePayload);
    const method = payload?.payment_method || payload?.payments?.[0]?.method || "cash";
    const payments = status === "draft"
      ? []
      : (payload?.payments?.length ? payload.payments : [{ method, amount: total, transaction_ref: null }]);
    const { data, error } = await getSupabase().rpc("create_sales_order", {
      p_branch_id: branchId,
      p_payload: {
        items,
        payments,
        customer_id: payload?.customer_id || null,
        voucher_code: payload?.voucher_code || null,
        points_to_redeem: payload?.points_to_redeem || 0,
        table_id: payload?.table_id || null,
        status,
        offline_ref: payload?.offline_ref || newLocalId("POS"),
      },
    });
    if (error) toApiError(error);
    if (payload?.send_to_kitchen && data?.order_id) {
      const { error: kitchenError } = await supabase
        .from("sales_order_items")
        .update({ status: "sent_to_kitchen" })
        .eq("order_id", data.order_id);
      if (kitchenError) toApiError(kitchenError);
    }
    return asResponse({
      ...data,
      id: data?.order_id,
      date: new Date().toISOString(),
      customer_name: normalizeVietnameseText(payload?.customer_name || "Khách vãng lai"),
      payment_method: method,
      items: payload?.receipt_items || payload?.items || [],
    });
  }

  const completeDraftMatch = path.match(/^\/api\/v1\/pos\/orders\/(\d+)\/complete$/);
  if (completeDraftMatch) {
    const orderId = Number(completeDraftMatch[1]);
    const { data, error } = await getSupabase().rpc("complete_draft_order", {
      p_branch_id: branchId,
      p_order_id: orderId,
      p_payload: {
        items: (payload?.items || []).map(toOrderLinePayload),
        payments: payload?.payments || [],
        customer_id: payload?.customer_id || null,
        voucher_code: payload?.voucher_code || null,
        points_to_redeem: payload?.points_to_redeem || 0,
        status: payload?.status || "completed",
        send_to_kitchen: Boolean(payload?.send_to_kitchen),
      },
    });
    if (error) toApiError(error);
    return asResponse({
      ...data,
      id: data?.order_id,
      date: new Date().toISOString(),
      customer_name: normalizeVietnameseText(payload?.customer_name || "Khách vãng lai"),
      payment_method: payload?.payment_method || payload?.payments?.[0]?.method || "cash",
      items: payload?.receipt_items || payload?.items || [],
    });
  }

  if (path === "/api/v1/menu/option-groups") {
    const { data, error } = await getSupabase().rpc("save_option_group", {
      p_branch_id: branchId,
      p_payload: payload,
    });
    if (error) toApiError(error);
    return asResponse(data);
  }

  if (path === "/api/v1/pos/products") {
    // products là bảng danh mục: RLS cho manager+ ghi trực tiếp. Đổi giá sau
    // khi tạo vẫn phải qua request_price_change (trigger products_price_guard).
    const { data, error } = await getSupabase()
      .from("products")
      .insert({
        organization_id: organizationId,
        branch_id: branchId,
        name: String(payload?.name || "").trim(),
        price: Number(payload?.price || 0),
        category: String(payload?.category || "").trim() || "Khác",
        image_url: payload?.image_url || null,
      })
      .select()
      .single();
    if (error) toApiError(error);
    return asResponse(data);
  }

  if (path === "/api/v1/pos/orders/sync-batch") {
    // Đồng bộ từng đơn độc lập: một đơn lỗi (VD tùy chọn đã bị ngừng dùng) không
    // chặn các đơn còn lại. local_id làm offline_ref nên gửi lại là idempotent.
    const synced_local_ids: string[] = [];
    // permanent = server từ chối vì dữ liệu → không tự gửi lại; còn lại là lỗi mạng
    const failed: { local_id: string; error: string; permanent: boolean }[] = [];
    for (const order of (payload?.orders || []) as OfflineOrder[]) {
      const paid = order.final_amount ?? Math.max(0, order.total_amount - (order.discount_amount || 0));
      try {
        // Gửi đúng những gì thu ở quầy: voucher + khách + số tiền thực thu.
        // Server tính lại; nếu lệch (voucher hết hạn, giá đổi...) đơn bị từ chối
        // để nhân viên xem lại, thay vì ghi sai sổ.
        await post("/api/v1/pos/orders", {
          items: order.items,
          customer_id: order.customer_id ?? null,
          voucher_code: order.voucher_code ?? null,
          table_id: order.table_id ?? null,
          payment_method: order.payment_method,
          payments: [{ method: order.payment_method, amount: paid, transaction_ref: null }],
          total_amount: order.total_amount,
          status: "completed",
          offline_ref: order.local_id,
        });
        synced_local_ids.push(order.local_id);
      } catch (err: any) {
        failed.push({
          local_id: order.local_id,
          error: err?.response?.data?.detail || err?.message || "Đồng bộ thất bại",
          permanent: Boolean(err?.code),
        });
      }
    }
    return asResponse({ synced: synced_local_ids.length, synced_local_ids, failed });
  }

  if (path === "/api/v1/inventory/ingredients") {
    // Qua RPC để tồn kho đầu kỳ được ghi kèm phiếu điều chỉnh + stock_movements,
    // thay vì set thẳng cột cache ingredients.stock.
    const { data, error } = await getSupabase().rpc("create_ingredient", {
      p_branch_id: branchId,
      p_payload: {
        name: payload?.name,
        unit: payload?.unit,
        min_stock: payload?.min_stock || 0,
        cost_price: payload?.cost_price || 0,
        opening_stock: payload?.stock || 0,
      },
    });
    if (error) toApiError(error);
    return asResponse(data);
  }

  if (path === "/api/v1/inventory/imports") {
    const { data, error } = await getSupabase().rpc("create_inventory_import", {
      p_branch_id: branchId,
      p_payload: {
        supplier_id: payload?.supplier_id || null,
        paid_amount: payload?.paid_amount ?? payload?.total_amount ?? 0,
        payment_method: payload?.payment_method || "cash",
        items: payload?.items || [],
      },
    });
    if (error) toApiError(error);
    return asResponse(data);
  }

  if (path === "/api/v1/expenses") {
    const { data, error } = await getSupabase().rpc("create_expense", {
      p_branch_id: branchId,
      p_payload: {
        category_id: payload?.category_id,
        sub_category: payload?.sub_category || "Khác",
        amount: payload?.amount,
        payment_method: payload?.payment_method || "cash",
        description: payload?.description || null,
      },
    });
    if (error) toApiError(error);
    return asResponse(data);
  }

  if (path === "/api/v1/cashbook") {
    const { data, error } = await getSupabase().rpc("create_cashbook_entry", {
      p_branch_id: branchId,
      p_payload: {
        type: payload?.type === "chi" ? "chi" : "thu",
        category: payload?.category || "Khác",
        amount: payload?.amount,
        payment_method: payload?.payment_method || "cash",
        description: payload?.description || null,
      },
    });
    if (error) toApiError(error);
    return asResponse(data);
  }

  if (path === "/api/v1/suppliers") {
    const { data, error } = await getSupabase().from("suppliers").insert({
      organization_id: organizationId,
      branch_id: branchId,
      name: payload?.name,
      phone: payload?.phone || null,
      address: payload?.address || null,
    }).select().single();
    if (error) toApiError(error);
    return asResponse(data);
  }

  if (path.match(/^\/api\/v1\/suppliers\/\d+\/pay-debt$/)) {
    const supplierId = Number(path.split("/")[4]);
    const { data, error } = await getSupabase().rpc("pay_supplier_debt", {
      p_branch_id: branchId,
      p_payload: {
        supplier_id: supplierId,
        amount: payload?.amount,
        payment_method: payload?.payment_method || "cash",
        description: payload?.description || null,
      },
    });
    if (error) toApiError(error);
    return asResponse(data);
  }

  if (path === "/api/v1/pos/customers") {
    const { data, error } = await getSupabase().from("customers").insert({
      organization_id: organizationId,
      branch_id: branchId,
      name: payload?.name,
      phone: payload?.phone,
    }).select().single();
    if (error) toApiError(error);
    return asResponse(data);
  }

  if (path === "/api/v1/tables/areas") {
    const { data, error } = await getSupabase().from("areas").insert({ organization_id: organizationId, branch_id: branchId, name: payload?.name }).select().single();
    if (error) toApiError(error);
    return asResponse(data);
  }

  if (path === "/api/v1/tables/tables") {
    const { data, error } = await getSupabase().from("tables").insert({ organization_id: organizationId, branch_id: branchId, area_id: payload?.area_id, name: payload?.name }).select().single();
    if (error) toApiError(error);
    return asResponse(data);
  }

  if (path === "/api/v1/adjustments") {
    const { data, error } = await getSupabase().from("inventory_adjustments").insert({
      organization_id: organizationId,
      branch_id: branchId,
      ingredient_id: payload?.ingredient_id,
      quantity_delta: payload?.quantity_delta,
      type: payload?.type || "LOSS",
      reason: payload?.reason,
      status: "PENDING",
      created_by_id: profile.id,
    }).select().single();
    if (error) toApiError(error);
    return asResponse(data);
  }

  if (path.match(/^\/api\/v1\/adjustments\/\d+\/approve$/)) {
    const adjustmentId = Number(path.split("/")[4]);
    const { data, error } = await getSupabase().rpc("approve_inventory_adjustment", {
      p_adjustment_id: adjustmentId,
      p_approved: true,
      p_note: payload?.note || null,
    });
    if (error) toApiError(error);
    return asResponse(data);
  }

  if (path === "/api/v1/marketing/campaigns") {
    const { data, error } = await getSupabase().from("marketing_campaigns").insert({
      organization_id: organizationId,
      branch_id: branchId,
      ...payload,
    }).select().single();
    if (error) toApiError(error);
    return asResponse(data);
  }

  if (path === "/api/v1/auth/register") {
    const { data, error } = await invokeFunction("manage-branch-user", {
      action: "create",
      branch_id: branchId,
      username: payload?.username,
      password: payload?.password,
      full_name: payload?.full_name || null,
      role: payload?.role || "staff",
      hourly_rate: payload?.hourly_rate ?? 20000,
    });
    if (error) toApiError(error);
    return asResponse(data);
  }

  const paySalaryMatch = path.match(/^\/api\/v1\/auth\/users\/([^/]+)\/pay-salary$/);
  if (paySalaryMatch) {
    const { data, error } = await getSupabase().rpc("pay_salary", {
      p_branch_id: branchId,
      p_payload: {
        user_id: decodeURIComponent(paySalaryMatch[1]),
        amount: payload?.amount,
        payment_method: payload?.payment_method || "cash",
        notes: payload?.notes || null,
      },
    });
    if (error) toApiError(error);
    return asResponse(data);
  }

  if (path === "/api/v1/marketing/customers/recalculate-tiers") {
    const { data, error } = await getSupabase().rpc("recalculate_customer_tiers", {
      p_branch_id: branchId,
    });
    if (error) toApiError(error);
    return asResponse(data);
  }
  unsupportedFeature(`POST ${path}`);
}

async function patch(path: string, payload?: any, _config?: ApiConfig): Promise<ApiResponse> {
  const superStoreMatch = path.match(/^\/api\/v1\/auth\/super\/stores\/(\d+)$/);
  if (superStoreMatch) {
    const { data, error } = await invokeFunction("manage-branch-user", {
      action: "update_store",
      organization_id: Number(superStoreMatch[1]),
      name: payload?.name,
      address: payload?.address || null,
      phone: payload?.phone || null,
      subscription_tier: payload?.subscription_tier,
      subscription_expires_at: payload?.subscription_expires_at || null,
      is_active: payload?.is_active,
    });
    if (error) toApiError(error);
    return asResponse(data);
  }

  const { branchId } = await activeContext();

  const itemStatusMatch = path.match(/^\/api\/v1\/pos\/order-items\/(\d+)\/status$/);
  if (itemStatusMatch) {
    const itemId = Number(itemStatusMatch[1]);
    const status = payload?.status;
    if (!["pending", "sent_to_kitchen", "served", "kitchen_cancelled", "refunded"].includes(status)) {
      throw { response: { data: { detail: "Invalid order item status" }, status: 400 } };
    }
    const { data, error } = await supabase
      .from("sales_order_items")
      .update({ status })
      .eq("id", itemId)
      .select("*, sales_orders!inner(branch_id)")
      .eq("sales_orders.branch_id", branchId)
      .single();
    if (error) toApiError(error);
    return asResponse(data);
  }

  const productMatch = path.match(/^\/api\/v1\/pos\/products\/(\d+)$/);
  if (productMatch) {
    const productId = Number(productMatch[1]);
    if (payload?.recipe !== undefined) {
      const { data, error } = await getSupabase().rpc("set_product_recipe", {
        p_product_id: productId,
        p_items: (payload.recipe || []).map((item: any) => ({
          ingredient_id: item.ingredient_id,
          quantity: item.quantity,
        })),
      });
      if (error) toApiError(error);
      return asResponse(data);
    }
    if (payload?.price !== undefined) {
      // Chủ quán: áp dụng ngay; quản lý: tạo yêu cầu chờ duyệt (xem rpc.changeProductPrice)
      const { data, error } = await getSupabase().rpc("change_product_price", {
        p_branch_id: branchId,
        p_product_id: productId,
        p_new_price: payload.price,
        p_reason: payload.reason || null,
      });
      if (error) toApiError(error);
      return asResponse(data);
    }
    const { data, error } = await getSupabase().from("products").update(payload).eq("id", productId).select().single();
    if (error) toApiError(error);
    return asResponse(data);
  }

  const cancelMatch = path.match(/^\/api\/v1\/pos\/orders\/(\d+)\/cancel$/);
  if (cancelMatch) {
    const orderId = Number(cancelMatch[1]);
    const { data: order } = await getSupabase().from("sales_orders").select("final_amount").eq("id", orderId).single();
    const { data, error } = await getSupabase().rpc("refund_order", {
      p_branch_id: branchId,
      p_payload: { order_id: orderId, payment_id: null, amount: order?.final_amount || 0, reason: payload?.reason || "Cancel order" },
    });
    if (error) toApiError(error);
    return asResponse(data);
  }

  const userMatch = path.match(/^\/api\/v1\/auth\/users\/(.+)$/);
  if (userMatch) {
    // Đổi mật khẩu / vai trò phải qua Admin API — profiles không có cột password
    // và user_assignments cũng phải khớp theo.
    const { data, error } = await invokeFunction("manage-branch-user", {
      action: "update",
      user_id: decodeURIComponent(userMatch[1]),
      password: payload?.password,
      full_name: payload?.full_name,
      role: payload?.role,
      hourly_rate: payload?.hourly_rate,
      is_active: payload?.is_active,
    });
    if (error) toApiError(error);
    return asResponse(data);
  }

  unsupportedFeature(`PATCH ${path}`);
}

async function del(path: string, _config?: ApiConfig): Promise<ApiResponse> {
  const superStoreMatch = path.match(/^\/api\/v1\/auth\/super\/stores\/(\d+)$/);
  if (superStoreMatch) {
    const { data, error } = await invokeFunction("manage-branch-user", {
      action: "delete_store",
      organization_id: Number(superStoreMatch[1]),
    });
    if (error) toApiError(error);
    return asResponse(data);
  }

  const userMatch = path.match(/^\/api\/v1\/auth\/users\/(.+)$/);
  if (userMatch) {
    // Khóa tài khoản (soft delete) — không xóa auth user để lịch sử ca/đơn còn
    // truy ngược được về người thao tác.
    const { data, error } = await invokeFunction("manage-branch-user", {
      action: "update",
      user_id: decodeURIComponent(userMatch[1]),
      is_active: false,
    });
    if (error) toApiError(error);
    return asResponse(data);
  }
  unsupportedFeature(`DELETE ${path}`);
}

const api = { get, post, patch, delete: del };

export default api;
