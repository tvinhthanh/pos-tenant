/**
 * Website shop (docs/website-design.md) — kiểu dữ liệu và tiện ích dùng chung cho
 * trang công khai (server) và trình chỉnh sửa (client). Không import gì chỉ chạy ở server.
 */

export type SectionType =
  | "hero" | "text" | "image_gallery" | "catalog" | "featured_items"
  | "hours" | "map" | "contact" | "cta_order" | "testimonials" | "faq";

export interface Section {
  id: string;
  type: SectionType;
  visible: boolean;
  props: Record<string, any>;
}

export interface SiteTheme {
  primary: string;
  accent: string;
  background: string;
  surface: string;
  text: string;
  muted: string;
  font: "sans" | "serif";
  radius: "none" | "sm" | "md" | "lg";
  logo?: string;
}

export interface OpeningHours {
  days: number[];
  open: string;
  close: string;
}

export interface Integrations {
  zalo_phone?: string;
  zalo_oa?: string;
  messenger_page?: string;
  facebook_url?: string;
  hotline?: string;
  map_query?: string;
  map_lat?: string;
  map_lng?: string;
}

export type BusinessType = "fnb" | "retail" | "rental";
export type Fulfillment = "pickup" | "dine_in" | "delivery";

export interface PublicSite {
  shop: string;
  name: string;
  tagline: string | null;
  business_type: BusinessType;
  address: string | null;
  phone: string | null;
  logo_url: string | null;
  theme: SiteTheme;
  integrations: Integrations;
  opening_hours: OpeningHours[];
  published_at: string | null;
  custom_domain: string | null;
  nav: { path: string; title: string }[];
  online: {
    accept_orders: boolean;
    accept_reservations: boolean;
    fulfillments: Fulfillment[];
    min_order_amount: number;
    notice: string | null;
  } | null;
}

export interface PublicPage {
  path: string;
  title: string;
  kind: string;
  sections: Section[];
  seo: { title?: string; description?: string; og_image?: string; noindex?: boolean };
  published_at: string | null;
}

export interface CatalogItem {
  id: number;
  name: string;
  category: string;
  price: number | null;
  image_url?: string | null;
  available: boolean;
  has_options?: boolean;
  sold_30d?: number;
  // cho thuê
  description?: string | null;
  rate_unit?: "hour" | "day" | "week" | "month" | "flat";
  deposit?: number;
  tracking_mode?: string;
}

/** Ngữ cảnh render một trang: dùng chung cho server và khung xem trước */
export interface SiteContext {
  site: PublicSite;
  catalog: CatalogItem[];
  /** Tiền tố đường dẫn: "" khi chạy trên tên miền shop, "/site/<shop>" khi xem qua app */
  base: string;
}

export const SECTION_LABELS: Record<SectionType, string> = {
  hero: "Ảnh bìa & tiêu đề",
  text: "Đoạn văn",
  image_gallery: "Bộ ảnh",
  catalog: "Danh mục / bảng giá",
  featured_items: "Món nổi bật",
  hours: "Giờ mở cửa",
  map: "Bản đồ",
  contact: "Liên hệ",
  cta_order: "Nút đặt hàng",
  testimonials: "Khách nói gì",
  faq: "Hỏi đáp",
};

export const SECTION_DEFAULTS: Record<SectionType, Record<string, any>> = {
  hero: { heading: "Tiêu đề lớn", subheading: "Một câu giới thiệu ngắn.", cta_label: "", cta_href: "", image: "" },
  text: { heading: "Tiêu đề", body: "Nội dung…" },
  image_gallery: { heading: "Hình ảnh", images: [] },
  catalog: { heading: "Danh mục", show_prices: true, category: "" },
  featured_items: { heading: "Nổi bật", limit: 6 },
  hours: { heading: "Giờ mở cửa" },
  map: { heading: "Bản đồ" },
  contact: { heading: "Liên hệ" },
  cta_order: { heading: "Đặt trước, đến là có", body: "", label: "Đặt ngay" },
  testimonials: { heading: "Khách nói gì", items: [{ name: "Chị Lan", quote: "Phục vụ nhanh, món ngon." }] },
  faq: { heading: "Câu hỏi thường gặp", items: [{ q: "Câu hỏi?", a: "Trả lời." }] },
};

export const RATE_UNIT_LABELS: Record<string, string> = {
  hour: "giờ", day: "ngày", week: "tuần", month: "tháng", flat: "lượt",
};
export const FULFILLMENT_LABELS: Record<Fulfillment, string> = {
  pickup: "Đến lấy", dine_in: "Dùng tại quán", delivery: "Giao hàng",
};
export const DAY_LABELS = ["", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy", "Chủ nhật"];

export const vnd = (n: number | null | undefined) => `${Math.round(Number(n || 0)).toLocaleString("vi-VN")}đ`;

const RADIUS = { none: "0px", sm: "6px", md: "12px", lg: "20px" } as const;

/** Biến CSS cho theme — đặt ở thẻ bao ngoài website / khung xem trước */
export function themeVars(t: SiteTheme): Record<string, string> {
  return {
    "--c-primary": t.primary,
    "--c-accent": t.accent,
    "--c-bg": t.background,
    "--c-surface": t.surface,
    "--c-text": t.text,
    "--c-muted": t.muted,
    "--radius": RADIUS[t.radius] ?? "12px",
    "--font": t.font === "serif" ? "'Lora', Georgia, serif" : "'Be Vietnam Pro', system-ui, sans-serif",
  };
}

export const href = (base: string, path: string) => (path.startsWith("/") ? `${base}${path === "/" && base ? "" : path}` || "/" : path);

/** Link ngoài: chỉ http(s); đường dẫn tương đối gắn tiền tố base */
export function safeHref(base: string, url: string | undefined | null): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/")) return href(base, url);
  return null;
}

export function mapEmbedUrl(site: PublicSite): string | null {
  const i = site.integrations || {};
  const q = i.map_lat && i.map_lng ? `${i.map_lat},${i.map_lng}` : i.map_query || site.address;
  return q ? `https://maps.google.com/maps?q=${encodeURIComponent(q)}&z=16&output=embed` : null;
}
export function mapLinkUrl(site: PublicSite): string | null {
  const i = site.integrations || {};
  const q = i.map_lat && i.map_lng ? `${i.map_lat},${i.map_lng}` : i.map_query || site.address;
  return q ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` : null;
}

export function contactLinks(site: PublicSite) {
  const i = site.integrations || {};
  const phone = i.hotline || site.phone || null;
  return {
    phone,
    tel: phone ? `tel:${phone.replace(/\s/g, "")}` : null,
    zalo: i.zalo_oa ? `https://zalo.me/${i.zalo_oa}` : i.zalo_phone ? `https://zalo.me/${i.zalo_phone}` : null,
    messenger: i.messenger_page ? `https://m.me/${i.messenger_page}` : null,
    facebook: i.facebook_url || null,
  };
}

/** Gộp giờ mở cửa theo ngày để hiển thị và JSON-LD */
export function hoursByDay(hours: OpeningHours[]): { day: number; ranges: string[] }[] {
  return [1, 2, 3, 4, 5, 6, 7].map((d) => ({
    day: d,
    ranges: hours.filter((h) => h.days.includes(d)).map((h) => `${h.open}–${h.close}`),
  }));
}

export function isOpenNow(hours: OpeningHours[], now = new Date()): boolean | null {
  if (!hours?.length) return null;
  // Giờ Việt Nam bất kể máy chủ đặt múi giờ nào
  const vn = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
  const day = vn.getDay() === 0 ? 7 : vn.getDay();
  const mins = vn.getHours() * 60 + vn.getMinutes();
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  return hours.some((h) => {
    if (!h.days.includes(day)) return false;
    const o = toMin(h.open), c = toMin(h.close);
    return c > o ? mins >= o && mins < c : mins >= o || mins < c; // qua nửa đêm
  });
}

export function siteUrl(site: PublicSite, platformDomain: string, path = "/"): string {
  const host = site.custom_domain || (platformDomain ? `${site.shop}.${platformDomain}` : "");
  return host ? `https://${host}${path === "/" ? "" : path}` : path;
}

export function newSectionId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Chuỗi → đường dẫn trang: bỏ dấu, chữ thường, gạch ngang */
export function slugify(s: string): string {
  return s
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d").replace(/Đ/g, "d")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}
