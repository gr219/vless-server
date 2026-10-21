import { useEffect, useState } from "react"
import { Moon, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"

type Theme = "light" | "dark"
const KEY = "sieudata-theme"

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === "light" || saved === "dark") return saved
  } catch { /* bộ nhớ trình duyệt có thể bị chặn */ }
  return "light" // mặc định giao diện sáng
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(initialTheme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark"
    setTheme(next)
    try { localStorage.setItem(KEY, next) } catch { /* bỏ qua */ }
  }

  return (
    <Button variant="outline" size="sm" onClick={toggle} aria-label={theme === "dark" ? "Chuyển sang giao diện sáng" : "Chuyển sang giao diện tối"}>
      {theme === "dark" ? <Sun /> : <Moon />}
      {theme === "dark" ? "Sáng" : "Tối"}
    </Button>
  )
}
