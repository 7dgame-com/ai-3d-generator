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
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useTheme } from '../composables/useTheme'
import { usePermissions } from '../composables/usePermissions'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

useTheme()

const { can } = usePermissions()

const activeRoute = computed(() => route.path)

function handleNavSelect(index: string) {
  router.push(index)
}
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
