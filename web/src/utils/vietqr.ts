/**
 * VietQR (chuẩn EMVCo của NAPAS) cho đơn online chuyển khoản — docs/website-design.md §8.
 * Không gọi API ngân hàng: dựng mã QR có sẵn số tiền + nội dung CK, nhân viên đối soát tay theo mã.
 * Dùng chung cho website khách và màn quản trị (không import gì chỉ chạy ở server).
 */

/** Ngân hàng phổ biến: mã BIN NAPAS → tên hiển thị */
export const VN_BANKS: { bin: string; name: string }[] = [
  { bin: "970436", name: "Vietcombank" },
  { bin: "970415", name: "VietinBank" },
  { bin: "970418", name: "BIDV" },
  { bin: "970405", name: "Agribank" },
  { bin: "970407", name: "Techcombank" },
  { bin: "970422", name: "MB Bank" },
  { bin: "970416", name: "ACB" },
  { bin: "970432", name: "VPBank" },
  { bin: "970423", name: "TPBank" },
  { bin: "970403", name: "Sacombank" },
  { bin: "970437", name: "HDBank" },
  { bin: "970441", name: "VIB" },
  { bin: "970443", name: "SHB" },
  { bin: "970431", name: "Eximbank" },
  { bin: "970426", name: "MSB" },
  { bin: "970440", name: "SeABank" },
  { bin: "970448", name: "OCB" },
  { bin: "970449", name: "LPBank" },
  { bin: "970428", name: "Nam A Bank" },
  { bin: "970409", name: "Bac A Bank" },
  { bin: "970425", name: "ABBANK" },
  { bin: "970454", name: "Bản Việt (BVBank)" },
  { bin: "970412", name: "PVcomBank" },
  { bin: "970452", name: "KienlongBank" },
];

export const bankName = (bin?: string | null) => VN_BANKS.find((b) => b.bin === bin)?.name ?? (bin ? `Ngân hàng ${bin}` : "");

/** "Nguyễn Văn A" → "NGUYEN VAN A" (ngân hàng hiển thị tên chủ tài khoản không dấu) */
export function toAccountName(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[đĐ]/g, "D")
    .toUpperCase().replace(/[^A-Z0-9 ]/g, "").replace(/\s+/g, " ").trimStart().slice(0, 50);
}

export interface TransferInfo {
  bank_bin: string;
  bank_account_no: string;
  bank_account_name: string;
  amount: number;
  transfer_code: string;
}

const tlv = (id: string, value: string) => `${id}${String(value.length).padStart(2, "0")}${value}`;

/** CRC-16/CCITT-FALSE (khởi tạo 0xFFFF, đa thức 0x1021) theo EMVCo */
function crc16(s: string): string {
  let crc = 0xffff;
  for (const ch of new TextEncoder().encode(s)) {
    crc ^= ch << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** Chuỗi EMVCo VietQR (chuyển khoản tới số tài khoản, có số tiền + nội dung) */
export function vietQrPayload(t: TransferInfo): string {
  const merchant = tlv("00", "A000000727")
    + tlv("01", tlv("00", t.bank_bin) + tlv("01", t.bank_account_no))
    + tlv("02", "QRIBFTTA");
  const body = tlv("00", "01")
    + tlv("01", t.amount > 0 ? "12" : "11")
    + tlv("38", merchant)
    + tlv("53", "704")
    + (t.amount > 0 ? tlv("54", String(Math.round(t.amount))) : "")
    + tlv("58", "VN")
    + tlv("62", tlv("08", t.transfer_code))
    + "6304";
  return body + crc16(body);
}

/** Ảnh QR dựng sẵn (img.vietqr.io) — cùng nội dung với vietQrPayload */
export function vietQrImageUrl(t: TransferInfo): string {
  const q = new URLSearchParams({
    amount: String(Math.round(t.amount)),
    addInfo: t.transfer_code,
    accountName: t.bank_account_name,
  });
  return `https://img.vietqr.io/image/${encodeURIComponent(t.bank_bin)}-${encodeURIComponent(t.bank_account_no)}-compact2.png?${q}`;
}

/** Tìm mã CK của đơn online trong nội dung sao kê / tin báo ngân hàng (ngân hàng có thể bỏ khoảng trắng, đổi hoa thường) */
export function findTransferCodes(text: string): string[] {
  return Array.from(new Set((text.toUpperCase().replace(/[^A-Z0-9]/g, "").match(/OL\d{6}[0-9A-F]{4}/g) || [])));
}
