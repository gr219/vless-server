import { Check } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { carriers, type Option } from "@/data"
import { cn } from "@/lib/utils"
import { Rich } from "./Rich"

function OptionCard({ o }: { o: Option }) {
  return (
    <Card className={cn("flex flex-col", o.highlight && "border-primary")}>
      <CardHeader>
        {o.badge && <Badge variant="tag" className="self-start">{o.badge}</Badge>}
        <CardTitle>{o.title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        <p className="rounded-md bg-secondary p-3 text-sm">{o.req}</p>
        <dl className="grid gap-2">
          {o.prices.map((p) => (
            <div key={p.label} className="flex items-baseline justify-between gap-3 border-t pt-2">
              <dt className="text-sm">{p.label}</dt>
              <dd className="whitespace-nowrap font-serif text-2xl font-semibold">{p.value}</dd>
            </div>
          ))}
        </dl>
        {o.bullets && (
          <ul className="grid gap-2 text-sm text-muted-foreground">
            {o.bullets.map((b) => (
              <li key={b} className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-primary" />{b}</li>
            ))}
          </ul>
        )}
        {o.note && <p className="text-[13px] text-muted-foreground">{o.note}</p>}
      </CardContent>
    </Card>
  )
}

export function CarrierTabs() {
  return (
    <Tabs defaultValue="vinaphone">
      <TabsList aria-label="Chọn nhà mạng">
        {carriers.map((c) => <TabsTrigger key={c.id} value={c.id}>{c.label}</TabsTrigger>)}
      </TabsList>
      {carriers.map((c) => (
        <TabsContent key={c.id} value={c.id}>
          <div className="grid gap-6 md:grid-cols-2">
            {c.options.map((o) => <OptionCard key={o.title} o={o} />)}
          </div>
          {c.guides && (
            <Accordion type="multiple" className="mt-6">
              {c.guides.map((g) => (
                <AccordionItem key={g.title} value={g.title}>
                  <AccordionTrigger>{g.title}</AccordionTrigger>
                  <AccordionContent>
                    <Table>
                      <TableHeader>
                        <TableRow>{g.columns.map((h) => <TableHead key={h}>{h}</TableHead>)}</TableRow>
                      </TableHeader>
                      <TableBody>
                        {g.rows.map((r) => (
                          <TableRow key={r[0]}>
                            {r.map((cell, i) => (
                              <TableCell key={i} className={i === 0 ? "font-medium" : undefined}><Rich text={cell} /></TableCell>
                            ))}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    {g.footer && <p className="mt-3 px-3 text-sm text-muted-foreground"><Rich text={g.footer} /></p>}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          )}
        </TabsContent>
      ))}
    </Tabs>
  )
}
