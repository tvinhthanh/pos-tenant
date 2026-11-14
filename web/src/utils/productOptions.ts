// Tùy chọn món (Size / Sốt / Topping...). Giá thật luôn do DB tính
// (rpc create_sales_order / complete_draft_order) — client chỉ gửi option_ids,
// phần tính ở đây chỉ để hiển thị.

export interface OptionItem {
  id: number;
  name: string;
  price_delta: number;
  is_default: boolean;
  sort_order: number;
}

export interface OptionGroup {
  id: number;
  name: string;
  min_select: number;
  max_select: number;
  sort_order: number;
  option_items: OptionItem[];
}

/** Tùy chọn đã chọn trên một dòng món (giỏ hàng hoặc hóa đơn đã lưu). */
export interface SelectedOption {
  option_item_id: number | null;
  group_name: string;
  option_name: string;
  price_delta: number;
}

export const bySortOrder = (a: { sort_order?: number; id?: number }, b: { sort_order?: number; id?: number }) =>
  (a.sort_order ?? 0) - (b.sort_order ?? 0) || (a.id ?? 0) - (b.id ?? 0);

/** Đơn giá hiển thị = giá món + tổng giá cộng thêm của tùy chọn. */
export const unitPriceOf = (basePrice: number, options: SelectedOption[]) =>
  basePrice + options.reduce((sum, option) => sum + Number(option.price_delta || 0), 0);

/** Id tùy chọn đã sắp xếp — dùng gửi lên RPC và so sánh hai dòng giỏ hàng. */
export const optionIdsOf = (options: SelectedOption[]) =>
  options
    .map((option) => option.option_item_id)
    .filter((id): id is number => id != null)
    .sort((a, b) => a - b);

/**
 * Giá thấp nhất có thể của món: giá gốc + các mục rẻ nhất mà nhóm bắt buộc
 * phải chọn (VD Size bắt buộc mà mục rẻ nhất +5.000đ thì "từ" phải cộng vào).
 */
export const minUnitPrice = (product: { price: number; option_groups?: OptionGroup[] }) =>
  product.price +
  (product.option_groups || []).reduce((sum, group) => {
    if (group.min_select <= 0) return sum;
    const cheapest = group.option_items
      .map((item) => Number(item.price_delta || 0))
      .sort((a, b) => a - b)
      .slice(0, group.min_select);
    return sum + cheapest.reduce((a, b) => a + b, 0);
  }, 0);

/** "Lớn, Phô mai" — dùng dưới tên món ở giỏ hàng / bếp. */
export const optionSummary = (options?: SelectedOption[]) =>
  (options || []).map((option) => option.option_name).join(", ");

/** "Gà viên (Lớn, Phô mai)" — dùng cho hóa đơn in. */
export const lineDisplayName = (name: string, options?: SelectedOption[]) => {
  const summary = optionSummary(options);
  return summary ? `${name} (${summary})` : name;
};

/** Map snapshot sales_order_item_options từ DB sang SelectedOption. */
export const mapOrderItemOptions = (rows: any[] | null | undefined): SelectedOption[] =>
  (rows || [])
    .slice()
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((row) => ({
      option_item_id: row.option_item_id ?? null,
      group_name: row.group_name_snapshot,
      option_name: row.option_name_snapshot,
      price_delta: Number(row.price_delta_snapshot || 0),
    }));

/** Lỗi chọn chưa hợp lệ cho một nhóm, hoặc null nếu hợp lệ. */
export const groupSelectionError = (group: OptionGroup, pickedCount: number) => {
  if (pickedCount < group.min_select) {
    return group.min_select === 1 ? `Chọn ${group.name}` : `Chọn ít nhất ${group.min_select} ${group.name}`;
  }
  if (pickedCount > group.max_select) return `Tối đa ${group.max_select} ${group.name}`;
  return null;
};

/** Mô tả quy tắc nhóm: "Bắt buộc · chọn 1", "Tùy chọn · tối đa 3". */
export const groupRuleLabel = (group: Pick<OptionGroup, "min_select" | "max_select">) => {
  const required = group.min_select > 0 ? "Bắt buộc" : "Không bắt buộc";
  const count = group.min_select === group.max_select
    ? `chọn ${group.max_select}`
    : group.min_select > 0
      ? `chọn ${group.min_select}–${group.max_select}`
      : `tối đa ${group.max_select}`;
  return `${required} · ${count}`;
};
