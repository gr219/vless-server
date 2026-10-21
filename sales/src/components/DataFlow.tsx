import { ArrowDown, Globe, Server, Smartphone } from "lucide-react"
import { cn } from "@/lib/utils"

const nodes = [
  { icon: Smartphone, title: "Điện thoại của bạn", text: "Dùng 4G/5G kèm gói cước nền bạn tự đăng ký", link: "Dữ liệu mã hóa" },
  { icon: Server, title: "Máy chủ VPN", text: "Nhận dữ liệu và gửi ra internet thay bạn", link: "Mang IP của máy chủ VPN", vpn: true },
  { icon: Globe, title: "Internet", text: "YouTube, TikTok, web, game..." },
]

export function DataFlow() {
  return (
    <ol className="grid" aria-label="Luồng dữ liệu: điện thoại, qua máy chủ VPN, ra internet">
      {nodes.map((n) => (
        <li key={n.title}>
          <div className={cn("flex items-center gap-4 rounded-xl p-4", n.vpn ? "bg-secondary" : "border-t")}>
            <n.icon className="size-9 shrink-0 text-primary" strokeWidth={1.5} />
            <div>
              <p className="font-medium">{n.title}</p>
              <p className="text-sm text-muted-foreground">{n.text}</p>
            </div>
          </div>
          {n.link && (
            <div className="flex items-center gap-2 py-2 pl-5 text-xs text-muted-foreground">
              <ArrowDown className="size-4" />
              {n.link}
            </div>
          )}
        </li>
      ))}
    </ol>
  )
}
