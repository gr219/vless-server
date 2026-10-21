// Nội dung giá và gói cước. Dấu ` ` bao quanh văn bản sẽ hiển thị dạng mã (cú pháp soạn tin).
export type Option = {
  title: string
  badge?: string
  highlight?: boolean
  req: string
  prices: { label: string; value: string }[]
  note?: string
  bullets?: string[]
}

export type Guide = {
  title: string
  columns: string[]
  rows: string[][]
  footer?: string
}

export type Carrier = {
  id: string
  label: string
  options: Option[]
  guides?: Guide[]
}

const MONTH = "VPN theo tháng"
const FOREVER = "VPN dùng thoải mái, không tính thời hạn"

export const carriers: Carrier[] = [
  {
    id: "vinaphone",
    label: "VinaPhone",
    options: [
      {
        title: "1. Không cần đăng ký gói cước",
        req: "Không cần gói cước nền.",
        prices: [{ label: MONTH, value: "30.000đ" }, { label: FOREVER, value: "100.000đ" }],
        note: "Nếu lựa chọn này không còn khả dụng, chúng tôi hỗ trợ chuyển sang VPN của gói TikTok.",
      },
      {
        title: "2. Cần đăng ký gói cước TikTok",
        req: "Bạn tự đăng ký gói TikTok với VinaPhone (xem bảng gói bên dưới).",
        prices: [{ label: MONTH, value: "30.000đ" }, { label: FOREVER, value: "100.000đ" }],
      },
    ],
    guides: [
      {
        title: "Cách đăng ký gói TikTok của VinaPhone (tự đăng ký)",
        columns: ["Gói", "Giá", "Thời hạn", "Cú pháp (gửi 888)", "Ưu đãi chính"],
        rows: [
          ["TK1", "3.000đ", "1 ngày (24h)", "`DK TK1` hoặc `TK1`", "Miễn phí data xem TikTok"],
          ["TK7", "10.000đ", "7 ngày", "`DK TK7` hoặc `TK7`", "Miễn phí data xem TikTok"],
          ["TK30", "30.000đ", "30 ngày", "`DK TK30` hoặc `TK30`", "Miễn phí data xem TikTok"],
          ["YOLO100M", "100.000đ", "30 ngày", "`DK YOLO100`", "1GB/ngày + miễn phí TikTok, FB, YT"],
          ["VD120M", "120.000đ", "30 ngày", "`DK VD120M` gửi 900", "30GB + miễn phí TikTok, FB, YT + gọi nội mạng"],
        ],
      },
    ],
  },
  {
    id: "viettel",
    label: "Viettel",
    options: [
      {
        title: "1. Cần đăng ký gói cước TikTok",
        req: "Bạn tự đăng ký gói TikTok với Viettel (xem bảng gói bên dưới).",
        prices: [{ label: MONTH, value: "30.000đ" }, { label: FOREVER, value: "100.000đ" }],
      },
      {
        title: "2. Cần đăng ký gói cước TV360",
        badge: "Ưu điểm lớn",
        highlight: true,
        req: "Bạn tự đăng ký gói 5GSPORT với Viettel (xem bảng bên dưới).",
        prices: [{ label: FOREVER, value: "1.000.000đ" }],
        bullets: [
          "Mạng Viettel 5G phủ sóng rộng, ping thấp, chơi game được (máy chủ trong nước).",
          "Data thoải mái.",
        ],
      },
    ],
    guides: [
      {
        title: "Cách đăng ký gói TikTok của Viettel (tự đăng ký)",
        columns: ["Gói", "Giá", "Ưu đãi", "Cú pháp"],
        rows: [
          ["T5K", "5.000đ / 24 giờ", "15GB TikTok", "Theo hướng dẫn của Viettel"],
          ["T15K", "15.000đ / 7 ngày", "25GB TikTok, không cần đăng ký lại mỗi ngày", "`T15K VTX` gửi 290"],
          ["T50K", "50.000đ / 30 ngày", "50GB TikTok dùng cả tháng, trả trước và trả sau", "`T50K VTX` gửi 290"],
          ["MXH100", "100.000đ / 30 ngày", "Free TikTok, YouTube, Facebook + 1GB/ngày data thường (thuê bao đủ điều kiện)", "`MXH100 VTX` gửi 290"],
        ],
      },
      {
        title: "Cách đăng ký gói TV360 (5GSPORT) của Viettel (tự đăng ký)",
        columns: ["Gói", "Giá", "Thời hạn", "Ưu đãi"],
        rows: [["5GSPORT", "15.000đ", "30 ngày, tự gia hạn", "Miễn phí data truy cập TV360 để xem truyền hình và các giải thể thao"]],
        footer: "Đăng ký: soạn `5GSPORT` gửi 191. Hủy gia hạn: soạn `HUY 5GSPORT` gửi 191. Hủy gói cước: soạn `HUYDATA 5GSPORT` gửi 191.",
      },
    ],
  },
  {
    id: "mobifone",
    label: "MobiFone",
    options: [
      {
        title: "Cần đăng ký gói MESV + TIK10",
        badge: "Giá tốt nhất",
        highlight: true,
        req: "Bạn tự đăng ký gói MESV (20.000đ/tháng) và thêm gói TIK10 (10.000đ/tháng), tổng 30.000đ/tháng, để truy cập TikTok với giá tốt nhất.",
        prices: [{ label: MONTH, value: "30.000đ" }, { label: FOREVER, value: "100.000đ" }],
      },
    ],
    guides: [
      {
        title: "Cách đăng ký MESV và TIK10 của MobiFone (tự đăng ký)",
        columns: ["Gói", "Giá", "Thời hạn", "Cú pháp (gửi 9199)", "Ưu đãi"],
        rows: [
          ["MESV", "20.000đ", "30 ngày, tự gia hạn", "`DK MESV` hoặc `MESV`", "100 phút gọi nội mạng và 100 tin nhắn nội mạng. Đăng ký trước, làm gói nền cho TIK10."],
          ["TIK10", "10.000đ", "30 ngày, tự gia hạn", "`DK TIK10`", "Không giới hạn dung lượng truy cập TikTok. Chỉ đăng ký kèm gói nền như MESV."],
        ],
        footer: "Hủy gói: `HUY MESV` hoặc `HUY TIK10`. Không gia hạn: `KGH MESV` hoặc `KGH TIK10` (đều gửi 9199). Ưu đãi không áp dụng khi chuyển vùng (roaming). Chi tiết tại trang gói cước của MobiFone.",
      },
    ],
  },
  {
    id: "khac",
    label: "Nhà mạng khác",
    options: [
      {
        title: "Cần đăng ký gói cước TikTok",
        req: "Bạn tự đăng ký gói cước nền TikTok với nhà mạng của mình và phải đăng ký thành công thì mới dùng được VPN. Hãy kiểm tra kỹ trước khi mua.",
        prices: [{ label: MONTH, value: "30.000đ" }, { label: FOREVER, value: "100.000đ" }],
      },
    ],
  },
]

export const faq = [
  { q: "Bạn bán gói cước nhà mạng không?", a: "Không. Chúng tôi chỉ bán VPN. Gói cước nền (nếu cần) bạn tự đăng ký trực tiếp với nhà mạng." },
  { q: "Dùng được trên nhà mạng nào?", a: "VinaPhone, Viettel, MobiFone và các nhà mạng khác. Mỗi nhà mạng có lựa chọn và giá riêng ở phần trên." },
  { q: "Cần ứng dụng nào?", a: "HAPP (miễn phí), Shadowrocket (có phí) hoặc bất kỳ ứng dụng VLESS nào, trên Android và iOS. Liên kết tải ở phần \"Ứng dụng cần dùng\"." },
  { q: "Vì sao thông báo trên iOS bị trễ?", a: "Khi màn hình tắt, iOS có thể ngắt kết nối nền của ứng dụng VPN, nên thông báo từ các ứng dụng khác có thể đến muộn." },
]

export const apps = [
  { name: "HAPP", price: "Miễn phí", android: "https://play.google.com/store/apps/details?id=com.happproxy", ios: "https://apps.apple.com/us/app/happ-proxy-utility/id6504287215" },
  { name: "Shadowrocket", price: "Có phí", android: "https://play.google.com/store/apps/details?id=com.v2cross.proxy&gl=PT", ios: "https://apps.apple.com/us/app/shadowrocket/id932747118" },
]
