// Module quản lý in ấn hóa đơn nhiệt K80/K57 và kết nối Print Bridge

export interface ReceiptData {
  order_id: string;
  store_name?: string;
  store_address?: string;
  store_phone?: string;
  created_at: string;
  customer_name?: string;
  table_name?: string;
  items: Array<{
    name: string;
    quantity: number;
    price: number;
    amount: number;
  }>;
  total_amount: number;
  discount_amount: number;
  final_amount: number;
  payment_method: string;
  staff_name?: string;
}

const DEFAULT_STORE_INFO = {
  name: "OK, BÉE!",
  address: "Hóc Môn, TP. Hồ Chí Minh",
  phone: "0987.654.321",
};

/**
 * Tạo nội dung HTML in nhiệt khổ 80mm tối ưu cho Silent Printing
 */
export function generateThermalReceiptHTML(data: ReceiptData): string {
  const itemsHtml = data.items
    .map(
      (item) => `
      <tr>
        <td style="text-align: left; padding: 3px 0;">${item.name}</td>
        <td style="text-align: center; padding: 3px 0;">${item.quantity}</td>
        <td style="text-align: right; padding: 3px 0;">${item.price.toLocaleString("vi-VN")}</td>
        <td style="text-align: right; padding: 3px 0;">${item.amount.toLocaleString("vi-VN")}</td>
      </tr>
    `
    )
    .join("");

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Hóa đơn ${data.order_id}</title>
      <style>
        @page {
          size: 80mm auto;
          margin: 0;
        }
        body {
          font-family: 'Courier New', Courier, monospace;
          width: 76mm;
          margin: 0 auto;
          padding: 5px;
          font-size: 12px;
          color: #000;
        }
        .header {
          text-align: center;
          margin-bottom: 10px;
        }
        .header h2 {
          margin: 0;
          font-size: 16px;
          text-transform: uppercase;
        }
        .header p {
          margin: 2px 0;
          font-size: 11px;
        }
        .divider {
          border-top: 1px dashed #000;
          margin: 6px 0;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          font-size: 11px;
        }
        .totals {
          margin-top: 6px;
          font-size: 12px;
        }
        .totals div {
          display: flex;
          justify-content: space-between;
          padding: 2px 0;
        }
        .bold {
          font-weight: bold;
        }
        .footer {
          text-align: center;
          margin-top: 12px;
          font-size: 11px;
          font-style: italic;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h2>${data.store_name || DEFAULT_STORE_INFO.name}</h2>
        <p>GÀ RÁN - ĂN VẶT HÓC MÔN</p>
        <p>${data.store_address || DEFAULT_STORE_INFO.address}</p>
        <p>SĐT: ${data.store_phone || DEFAULT_STORE_INFO.phone}</p>
        <div class="divider"></div>
        <p class="bold">HÓA ĐƠN BÁN HÀNG</p>
        <p>Số HD: ${data.order_id}</p>
        <p>Ngày: ${data.created_at}</p>
        ${data.table_name ? `<p>Bàn: ${data.table_name}</p>` : ""}
        ${data.customer_name ? `<p>Khách: ${data.customer_name}</p>` : ""}
      </div>

      <div class="divider"></div>

      <table>
        <thead>
          <tr style="border-bottom: 1px dashed #000;">
            <th style="text-align: left;">Món</th>
            <th style="text-align: center;">SL</th>
            <th style="text-align: right;">Đ.Giá</th>
            <th style="text-align: right;">T.Tiền</th>
          </tr>
        </thead>
        <tbody>
          ${itemsHtml}
        </tbody>
      </table>

      <div class="divider"></div>

      <div class="totals">
        <div><span>Tổng tiền:</span> <span>${data.total_amount.toLocaleString("vi-VN")} đ</span></div>
        ${
          data.discount_amount > 0
            ? `<div><span>Giảm giá:</span> <span>-${data.discount_amount.toLocaleString("vi-VN")} đ</span></div>`
            : ""
        }
        <div class="bold" style="font-size: 14px; margin-top: 4px;">
          <span>THANH TOÁN:</span> <span>${data.final_amount.toLocaleString("vi-VN")} đ</span>
        </div>
        <div><span>P.Thức:</span> <span>${data.payment_method}</span></div>
      </div>

      <div class="divider"></div>
      <div class="footer">
        <p>Cảm ơn quý khách và hẹn gặp lại!</p>
      </div>
    </body>
    </html>
  `;
}

/**
 * Thực hiện in hóa đơn K80 qua iFrame ngầm (Web Silent Printing)
 */
export function printReceiptSilent(data: ReceiptData) {
  if (typeof window === "undefined") return;

  const htmlContent = generateThermalReceiptHTML(data);
  let iframe = document.getElementById("melio_print_iframe") as HTMLIFrameElement;

  if (!iframe) {
    iframe = document.createElement("iframe");
    iframe.id = "melio_print_iframe";
    iframe.style.position = "absolute";
    iframe.style.width = "0px";
    iframe.style.height = "0px";
    iframe.style.border = "none";
    document.body.appendChild(iframe);
  }

  const doc = iframe.contentWindow?.document;
  if (doc) {
    doc.open();
    doc.write(htmlContent);
    doc.close();

    setTimeout(() => {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    }, 250);
  }
}

/**
 * Kết nối tới Local Print Bridge (Mở két tiền RJ11 & In ESC/POS trực tiếp)
 */
export function sendToPrintBridge(
  receiptData: ReceiptData,
  bridgeUrl: string = "ws://127.0.0.1:9100"
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(bridgeUrl);
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            action: "PRINT_RECEIPT",
            open_cash_drawer: true,
            data: receiptData,
          })
        );
        ws.close();
        resolve(true);
      };
      ws.onerror = (err) => {
        console.warn("Print Bridge không phản hồi, fallback về Web Silent Print:", err);
        printReceiptSilent(receiptData);
        resolve(false);
      };
    } catch (err) {
      printReceiptSilent(receiptData);
      resolve(false);
    }
  });
}

/**
 * In một tài liệu HTML bất kỳ (hợp đồng A4, phiếu K80…) qua cùng iFrame ngầm
 * với printReceiptSilent. Nội dung phải tự escape dữ liệu người dùng.
 */
export function printHtmlSilent(htmlContent: string) {
  if (typeof window === "undefined") return;

  let iframe = document.getElementById("melio_print_iframe") as HTMLIFrameElement;
  if (!iframe) {
    iframe = document.createElement("iframe");
    iframe.id = "melio_print_iframe";
    iframe.style.position = "absolute";
    iframe.style.width = "0px";
    iframe.style.height = "0px";
    iframe.style.border = "none";
    document.body.appendChild(iframe);
  }

  const doc = iframe.contentWindow?.document;
  if (doc) {
    doc.open();
    doc.write(htmlContent);
    doc.close();
    setTimeout(() => {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    }, 250);
  }
}
