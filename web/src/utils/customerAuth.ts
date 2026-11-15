"use client";
/**
 * Tài khoản KHÁCH trên website shop: đăng nhập OTP số điện thoại (Supabase phone auth).
 * Client riêng, lưu phiên ở khóa khác với tài khoản nhân viên — xem trước website ngay
 * trong app quản trị cũng không lẫn phiên.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function customerClient(): SupabaseClient {
  if (!client) {
    client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "", {
      auth: { storageKey: "pos-customer-auth", persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
  }
  return client;
}

/** 0901234567 / +84 901 234 567 → +84901234567; sai định dạng → null */
export function toE164(phone: string): string | null {
  const d = phone.replace(/\D/g, "");
  if (/^0\d{9,10}$/.test(d)) return `+84${d.slice(1)}`;
  if (/^84\d{9,10}$/.test(d)) return `+${d}`;
  return null;
}

export function friendlyError(e: unknown, fallback: string): string {
  const msg = (e as { message?: string })?.message || "";
  if (/rate limit|too many|security purposes/i.test(msg)) return "Gửi mã quá nhiều lần. Vui lòng đợi một lúc rồi thử lại.";
  if (/expired|invalid.*otp|token has expired/i.test(msg)) return "Mã không đúng hoặc đã hết hạn.";
  if (/signups not allowed|sms.*disabled|unsupported phone provider/i.test(msg)) return "Shop chưa bật đăng nhập bằng số điện thoại.";
  return msg || fallback;
}

export async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await customerClient().rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}
