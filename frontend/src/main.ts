/**
 * 应用入口文件
 *
 * 初始化 Vue 应用并注册所有插件：
 * - Element Plus（UI 组件库，全量引入）
 * - Pinia（状态管理）
 * - Vue Router（路由）
 * - Vue I18n（国际化）
 * - 全局样式
 */
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import App from './App.vue'

// router 和 i18n 将在 task 7.7 / 7.5 中实现
// 使用动态导入避免循环依赖，并在模块不存在时优雅降级
async function bootstrap() {
  const app = createApp(App)

  // 注册所有 Element Plus 图标
  for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
    app.component(key, component)
  }

  // 注册插件
  app.use(createPinia())
  app.use(ElementPlus, { size: 'default' })

  // 动态加载 router（task 7.7 实现后生效）
  try {
    const { default: router } = await import('./router/index')
    app.use(router)
  } catch {
    console.warn('[main] router not yet implemented, skipping')
  }

  // 动态加载 i18n（task 7.5 实现后生效）
  try {
    const { default: i18n } = await import('./i18n/index')
    app.use(i18n)
  } catch {
    console.warn('[main] i18n not yet implemented, skipping')
  }

  app.mount('#app')
}

bootstrap()
