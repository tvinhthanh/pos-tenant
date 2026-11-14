// Khóa màn hình bằng mã PIN theo tài khoản.
//
// Nguồn đúng là DB (RPC verify_my_pin, có giới hạn sai 5 lần). Máy chỉ giữ
// thêm một bản băm PBKDF2 của PIN đã xác thực gần nhất để còn mở khóa được khi
// rớt mạng giữa ca. Bản băm này không bảo vệ gì thêm trước người đọc được
// localStorage (họ đã có sẵn phiên đăng nhập) — nó chỉ để mở khóa offline.

export const PIN_MIN = 4;
export const PIN_MAX = 6;
export const IDLE_LOCK_MS = 5 * 60 * 1000;
export const LOCAL_MAX_ATTEMPTS = 5;

const UNLOCKED_KEY = "melio_screen_unlocked";
const ACTIVITY_KEY = "melio_last_activity";
const localHashKey = (userId: string) => `melio_pin_${userId}`;

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// sessionStorage: đóng trình duyệt/tab là mất → mở lại app sẽ bị khóa.
export function isSessionUnlocked(userId: string): boolean {
  return safe(() => sessionStorage.getItem(UNLOCKED_KEY) === userId, false);
}

export function markUnlocked(userId: string) {
  safe(() => {
    sessionStorage.setItem(UNLOCKED_KEY, userId);
    sessionStorage.setItem(ACTIVITY_KEY, String(Date.now()));
  }, undefined);
}

export function markLocked() {
  safe(() => sessionStorage.removeItem(UNLOCKED_KEY), undefined);
}

export function touchActivity() {
  safe(() => sessionStorage.setItem(ACTIVITY_KEY, String(Date.now())), undefined);
}

export function idleExpired(): boolean {
  const last = safe(() => Number(sessionStorage.getItem(ACTIVITY_KEY) || 0), 0);
  return !last || Date.now() - last > IDLE_LOCK_MS;
}

const toHex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string) => new Uint8Array(hex.match(/../g)?.map((h) => parseInt(h, 16)) || []);

async function derive(pin: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: 150_000 },
    key,
    256,
  );
  return toHex(bits);
}

export async function cachePinLocally(userId: string, pin: string) {
  if (!globalThis.crypto?.subtle) return;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(pin, salt);
  safe(() => localStorage.setItem(localHashKey(userId), JSON.stringify({ salt: toHex(salt.buffer), hash })), undefined);
}

export function hasLocalPin(userId: string): boolean {
  return safe(() => Boolean(localStorage.getItem(localHashKey(userId))), false);
}

export async function verifyPinLocally(userId: string, pin: string): Promise<boolean> {
  if (!globalThis.crypto?.subtle) return false;
  const raw = safe(() => localStorage.getItem(localHashKey(userId)), null);
  if (!raw) return false;
  try {
    const { salt, hash } = JSON.parse(raw);
    return (await derive(pin, fromHex(salt))) === hash;
  } catch {
    return false;
  }
}

export function clearLocalPin(userId: string) {
  safe(() => localStorage.removeItem(localHashKey(userId)), undefined);
}

// Lỗi mạng (fetch hỏng) không có mã Postgres — phân biệt với lỗi nghiệp vụ.
export function isNetworkError(error: any): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  return !error?.code && /fetch|network|load failed/i.test(String(error?.message || error));
}
