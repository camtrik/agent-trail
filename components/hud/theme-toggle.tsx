'use client'

import { useHydrated } from '@/lib/use-hydrated'
import { Moon, Sun } from 'lucide-react'
import { useThemeStore } from '@/stores/theme-store'

export function ThemeToggle() {
  const { setTheme, resolvedTheme } = useThemeStore()
  const mounted = useHydrated()

  if (!mounted) {
    return (
      <button
        className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold tracking-wider border border-border"
        aria-label="Toggle theme"
      >
        <span className="w-3.5 h-3.5" />
        <span>—</span>
      </button>
    )
  }

  const toggleTheme = () => {
    const newTheme = resolvedTheme === 'dark' ? 'light' : 'dark'
    setTheme(newTheme)
  }

  return (
    <button
      onClick={toggleTheme}
      aria-label={resolvedTheme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
      className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold tracking-wider border border-border hover:bg-card hover:text-foreground transition-colors"
    >
      {resolvedTheme === 'dark' ? (
        <>
          <Sun className="w-3.5 h-3.5" />
          <span>LIGHT</span>
        </>
      ) : (
        <>
          <Moon className="w-3.5 h-3.5" />
          <span>DARK</span>
        </>
      )}
    </button>
  )
}
