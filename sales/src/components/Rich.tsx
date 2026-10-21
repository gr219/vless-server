import { Fragment } from "react"

/** Hiển thị `mã` thành thẻ <code>. */
export function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, i) =>
        i % 2 ? (
          <code key={i} className="rounded-sm bg-secondary px-1.5 py-0.5 font-mono text-[13px] text-secondary-foreground">{part}</code>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        )
      )}
    </>
  )
}
