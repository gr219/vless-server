import { Check, Minus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { CarrierTabs } from "@/components/CarrierTabs"
import { ThemeToggle } from "@/components/ThemeToggle"
import { DataFlow } from "@/components/DataFlow"
import { apps, faq } from "@/data"
import { config } from "@/config"

function Section({ id, title, lead, children }: { id?: string; title: string; lead?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="border-t py-16">
      <h2 className="font-serif text-3xl font-bold tracking-tight">{title}</h2>
      {lead && <p className="mt-3 max-w-prose text-muted-foreground">{lead}</p>}
      <div className="mt-8">{children}</div>
    </section>
  )
}

export default function App() {
  return (
    <div className="mx-auto max-w-5xl" style={{ paddingLeft: "max(16px, env(safe-area-inset-left, 0px))", paddingRight: "max(16px, env(safe-area-inset-right, 0px))" }}>
      <nav className="flex items-center justify-between py-4">
        <span className="font-serif text-xl font-bold">{config.brand}</span>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button variant="outline" asChild><a href="#nha-mang">Chọn nhà mạng</a></Button>
        </div>
      </nav>

      <header className="grid items-center gap-10 py-14 md:grid-cols-[1.2fr_.8fr]">
        <div>
          <p className="mb-3 text-sm font-medium text-primary">VPN VLESS cho 4G / 5G</p>
          <h1 className="font-serif text-4xl font-bold leading-tight tracking-tight md:text-5xl">
            Dùng 4G/5G thoải mái, <span className="text-primary">xem video không lo hết data</span>
          </h1>
          <p className="mt-4 max-w-prose text-lg text-muted-foreground">
            Chúng tôi chỉ bán VPN. Gói cước nền do bạn tự đăng ký với nhà mạng; VPN đưa dữ liệu của bạn qua máy chủ rồi mới ra internet.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button size="lg" asChild><a href="#nha-mang">Chọn nhà mạng</a></Button>
            <Button size="lg" variant="outline" asChild><a href="#uu-nhuoc">Ưu và nhược điểm</a></Button>
          </div>
        </div>
        <DataFlow />
      </header>

      <Section id="uu-nhuoc" title="Ưu và nhược điểm của VLESS" lead="Đọc kỹ trước khi mua để biết VPN có hợp với bạn không.">
        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Ưu điểm</CardTitle></CardHeader>
            <CardContent>
              <ul className="grid gap-3 text-sm">
                <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-primary" />Data 4G/5G thoải mái, xem video không sợ hết data.</li>
                <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-primary" />Dữ liệu đi qua máy chủ VPN nên IP hiển thị trên internet là IP của máy chủ, tăng thêm sự ẩn danh và bảo mật.</li>
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Hạn chế</CardTitle></CardHeader>
            <CardContent>
              <ul className="grid gap-3 text-sm">
                <li className="flex gap-2"><Minus className="mt-0.5 size-4 shrink-0 text-muted-foreground" />Trên iOS, thông báo từ ứng dụng có thể bị trễ hoặc không đến khi màn hình tắt.</li>
                <li className="flex gap-2"><Minus className="mt-0.5 size-4 shrink-0 text-muted-foreground" />Tốc độ không thể nhanh bằng dùng gói mạng chính thống, vì dữ liệu phải đi qua máy chủ VPN.</li>
              </ul>
            </CardContent>
          </Card>
        </div>
      </Section>

      <Section id="nha-mang" title="Chọn nhà mạng của bạn" lead="Giá VPN phụ thuộc nhà mạng và gói cước nền bạn dùng.">
        <CarrierTabs />
        <p className="mt-6 text-xs text-muted-foreground">
          Chúng tôi chỉ bán VPN. Gói cước nền do bạn tự đăng ký với nhà mạng; giá, cú pháp và điều kiện do nhà mạng quy định, có thể thay đổi và được chép lại ở đây chỉ để tham khảo. Hãy kiểm tra lại với nhà mạng trước khi đăng ký.
        </p>
      </Section>

      <Section id="ung-dung" title="Ứng dụng cần dùng" lead="Dùng HAPP, Shadowrocket hoặc bất kỳ ứng dụng VLESS nào bạn quen.">
        <div className="grid gap-6 md:grid-cols-3">
          {apps.map((a) => (
            <Card key={a.name}>
              <CardHeader><CardTitle>{a.name}</CardTitle><CardDescription>{a.price}</CardDescription></CardHeader>
              <CardContent className="flex gap-2">
                <Button variant="outline" asChild><a href={a.android} target="_blank" rel="noopener noreferrer">Android</a></Button>
                <Button variant="outline" asChild><a href={a.ios} target="_blank" rel="noopener noreferrer">iOS</a></Button>
              </CardContent>
            </Card>
          ))}
          <Card>
            <CardHeader><CardTitle>Ứng dụng khác</CardTitle><CardDescription>Bất kỳ ứng dụng hỗ trợ VLESS nào cũng dùng được.</CardDescription></CardHeader>
          </Card>
        </div>
      </Section>

      <Section title="Bắt đầu trong 3 bước">
        <ol className="grid gap-6 md:grid-cols-3">
          {[
            ["Chọn lựa chọn phù hợp", "Chọn nhà mạng, tự đăng ký gói nền nếu cần, rồi nhắn Telegram để mua VPN."],
            ["Nhận cấu hình", "Chúng tôi gửi link hoặc mã QR VLESS cho bạn."],
            ["Kết nối", "Dán vào HAPP, Shadowrocket hoặc ứng dụng VLESS bất kỳ rồi bấm kết nối."],
          ].map(([t, d], i) => (
            <li key={t} className="border-t pt-4">
              <p className="font-serif text-4xl font-semibold text-primary">{i + 1}</p>
              <h3 className="mt-2 font-serif text-xl font-semibold">{t}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{d}</p>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="Câu hỏi thường gặp">
        <Accordion type="single" collapsible defaultValue="0" className="max-w-3xl">
          {faq.map((f, i) => (
            <AccordionItem key={f.q} value={String(i)}>
              <AccordionTrigger>{f.q}</AccordionTrigger>
              <AccordionContent className="text-muted-foreground">{f.a}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </Section>

      <section id="lien-he" className="mb-10 flex flex-wrap items-center justify-between gap-6 rounded-xl bg-secondary p-8">
        <h2 className="font-serif text-3xl font-bold">Sẵn sàng dùng VPN?</h2>
        <div className="flex flex-wrap gap-3">
          <Button size="lg" asChild><a href={config.telegramUrl} target="_blank" rel="noopener noreferrer">Nhắn Telegram @justanitguy</a></Button>
        </div>
      </section>

      <footer className="pb-12 text-xs text-muted-foreground">
        {config.brand}. Tên nhà mạng và gói cước chỉ dùng để nêu khả năng tương thích, không thuộc sở hữu hay liên kết với các nhà mạng đó. Hãy sử dụng dịch vụ theo quy định pháp luật hiện hành.
      </footer>
    </div>
  )
}
