import { ref, watchEffect } from 'vue'

/**
 * 主题适配模块
 *
 * 支持的 6 种主题：
 * - modern-blue: 科技蓝，现代简洁（默认）
 * - deep-space: 深空蓝，专业沉浸（暗色）
 * - cyber-tech: 赛博霓虹，未来感（暗色）
 * - edu-friendly: 活力橙，温暖友好
 * - neo-brutalism: 大胆黄，艺术风格
 * - minimal-pure: 极简黑白，专注
 *
 * 工作原理：
 * 1. 初始加载时从 URL 参数 `?theme=xxx` 读取主题
 * 2. 运行时监听主系统的 THEME_CHANGE PostMessage 消息
 * 3. 通过 watchEffect 自动同步 data-theme 属性和 dark class 到 html 元素
 * 4. CSS 变量 + Element Plus 暗色模式自动生效
 *
 * 使用方式：
 * - 在 main.ts 中 `import './composables/useTheme'` 即可自动初始化
 * - 在组件中 `const { isDark, themeName } = useTheme()` 获取响应式状态
 */

/** 暗色主题列表 */
const DARK_THEMES = ['deep-space', 'cyber-tech']

/** 是否为暗色主题（响应式，全局单例） */
const isDark = ref(false)

/** 当前主题名称（响应式，全局单例） */
const themeName = ref('modern-blue')

/** 从 URL 参数读取初始主题 */
function initFromUrl() {
  const params = new URLSearchParams(window.location.search)
  const theme = params.get('theme')
  if (theme) {
    themeName.value = theme
    isDark.value = DARK_THEMES.includes(theme)
  }
}

/** 监听主系统的 THEME_CHANGE 消息 */
function listenForThemeChange() {
  window.addEventListener('message', (event) => {
    // 安全检查：只接受来自父窗口的消息
    if (event.source !== window.parent) return
    const { type, payload } = event.data || {}
    if (type === 'THEME_CHANGE' && payload?.theme) {
      themeName.value = payload.theme
      isDark.value = DARK_THEMES.includes(payload.theme)
    }
  })
}

/** 通过 watchEffect 自动同步主题到 DOM */
watchEffect(() => {
  const el = document.documentElement
  // 设置 data-theme 属性，CSS 变量通过 [data-theme="dark"] 选择器切换
  el.setAttribute('data-theme', isDark.value ? 'dark' : 'light')
  // Element Plus 内置暗黑模式需要 html.dark class
  if (isDark.value) {
    el.classList.add('dark')
  } else {
    el.classList.remove('dark')
  }
})

/**
 * 主题适配组合式函数
 *
 * @example
 * ```ts
 * import { useTheme } from '@/composables/useTheme'
 *
 * const { isDark, themeName } = useTheme()
 *
 * // 在模板中使用
 * // <div :class="{ 'dark-mode': isDark }">{{ themeName }}</div>
 * ```
 */
export function useTheme() {
  return { isDark, themeName }
}

// 模块加载时自动初始化（自执行）
initFromUrl()
listenForThemeChange()
