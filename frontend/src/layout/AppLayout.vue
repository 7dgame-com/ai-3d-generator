<template>
  <div class="app-layout">
    <header class="navbar">
      <el-menu
        mode="horizontal"
        :default-active="activeRoute"
        class="nav-menu"
        @select="handleNavSelect"
      >
        <el-menu-item index="/">
          {{ t('nav.generator') }}
        </el-menu-item>
        <el-menu-item v-if="can('view-usage')" index="/history">
          {{ t('nav.history') }}
        </el-menu-item>
        <el-menu-item v-if="can('admin-config')" index="/admin">
          {{ t('nav.admin') }}
        </el-menu-item>
      </el-menu>
    </header>

    <main class="content">
      <router-view />
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { usePluginMessageBridge } from '../composables/usePluginMessageBridge'
import { useTheme } from '../composables/useTheme'
import { usePermissions } from '../composables/usePermissions'
import { setToken, removeAllTokens } from '../utils/token'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

// 初始化主题同步（模块加载时已自动执行，此处确保响应式引用存在）
useTheme()

const { fetchAllowedActions, can } = usePermissions()

// 集成 PostMessage 握手
usePluginMessageBridge({
  onInit: async ({ token }) => {
    setToken(token)
    await fetchAllowedActions()
  },
  onTokenUpdate: (token) => {
    setToken(token)
  },
  onDestroy: () => {
    removeAllTokens()
  }
})

const activeRoute = computed(() => route.path)

function handleNavSelect(index: string) {
  router.push(index)
}

onMounted(async () => {
  // 如果已有 token（非首次加载），直接加载权限
  const { getToken } = await import('../utils/token')
  const token = getToken()
  if (token) {
    await fetchAllowedActions()
  }
  // 否则等待 INIT 消息（由 usePluginMessageBridge 的 onInit 回调处理）
})
</script>

<style scoped>
.app-layout {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-page);
}

.navbar {
  background: var(--bg-card);
  border-bottom: 1px solid var(--border-color);
  box-shadow: var(--shadow-sm);
}

.nav-menu {
  border-bottom: none;
}

.content {
  flex: 1;
  padding: var(--spacing-lg);
}
</style>
