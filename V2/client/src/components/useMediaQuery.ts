import { useEffect, useState } from 'react'

/**
 * 一个媒体查询 hook。
 *
 * 为什么需要它，而不是纯 CSS 的 `hidden lg:flex`：
 *
 *   移动端导航的要求是"**同一时刻只有一套导航**"。如果桌面侧边栏只是被 CSS 藏起来，
 *   它的 DOM 还在 —— 于是手机端抽屉打开时页面上会有**两份** `data-nav` 节点。
 *   后果不只是"多画一遍"：任何按 `[data-nav=...]` 定位的代码（浏览器用例、
 *   以后的脚本）都会先命中那份 `display:none` 的，点它就会失败或被判"不可交互"。
 *
 *   所以这里按视口**决定渲染哪一套**：桌面 → Sidebar；窄屏 → hamburger + Drawer。
 *   两份导航的**数据**仍然只有一份（都来自 DirectoryProvider + capabilities）。
 *
 * `matchMedia` 在浏览器里是同步可用的，所以首帧就是对的，不会先闪一下侧边栏。
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : true,
  )

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const list = window.matchMedia(query)
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches)
    setMatches(list.matches)
    // Safari < 14 只有 addListener；两种都挂上，避免某些引擎上监听不到。
    if (typeof list.addEventListener === 'function') {
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    }
    list.addListener(onChange)
    return () => list.removeListener(onChange)
  }, [query])

  return matches
}

/** 桌面断点，与 Tailwind 的 `lg` 一致（1024px）。全站只有这一处定义。 */
export const DESKTOP_QUERY = '(min-width: 1024px)'

export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY)
}
