/**
 * Thu nhỏ / nén ảnh ngay trên trình duyệt trước khi tải lên (canvas, không thêm thư viện).
 * Ảnh điện thoại 4–12 MB thường còn 150–600 KB: tải nhanh hơn, website nhẹ hơn, đỡ dung lượng gói.
 */

export interface ResizeOptions {
  /** Cạnh dài tối đa (px) */
  maxSize?: number;
  /** Chất lượng 0–1 cho WebP / JPEG */
  quality?: number;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function decode(file: File): Promise<{ img: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    // imageOrientation: xoay đúng chiều theo EXIF của ảnh chụp điện thoại
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
    return { img: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

/**
 * Trả về ảnh đã thu nhỏ (WebP, trình duyệt không hỗ trợ thì JPEG). Ảnh gốc đã nhỏ hơn
 * kết quả thì giữ nguyên. Không đọc được ảnh → trả lại file gốc để server tự kiểm.
 */
export async function resizeImage(file: File, opts: ResizeOptions = {}): Promise<File> {
  const maxSize = opts.maxSize ?? 1920;
  const quality = opts.quality ?? 0.82;
  let src;
  try {
    src = await decode(file);
  } catch {
    return file;
  }
  try {
    const scale = Math.min(1, maxSize / Math.max(src.width, src.height));
    const w = Math.max(1, Math.round(src.width * scale));
    const h = Math.max(1, Math.round(src.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.imageSmoothingQuality = "high";

    ctx.drawImage(src.img, 0, 0, w, h);
    let blob = await canvasToBlob(canvas, "image/webp", quality);
    // Safari cũ không xuất WebP (trả PNG): chuyển JPEG, nền trắng thay cho vùng trong suốt
    if (!blob || blob.type !== "image/webp") {
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      blob = await canvasToBlob(canvas, "image/jpeg", quality);
    }
    if (!blob || (scale === 1 && blob.size >= file.size)) return file;
    const ext = blob.type === "image/webp" ? "webp" : "jpg";
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + "." + ext, { type: blob.type, lastModified: Date.now() });
  } finally {
    src.close();
  }
}
