<template>
  <div v-if="waiting" class="iframe-waiting">
    <el-icon class="is-loading" style="font-size:32px;"><Loading /></el-icon>
  </div>
  <AppLayout v-else />
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Loading } from '@element-plus/icons-vue'
import AppLayout from './layout/AppLayout.vue'
import { usePluginMessageBridge } from './composables/usePluginMessageBridge'
import { usePermissions } from './composables/usePermissions'
import { isInIframe, getToken, setToken, removeAllTokens } from './utils/token'

const waiting = ref(false)
const { fetchAllowedActions } = usePermissions()

usePluginMessageBridge({
  onInit: async ({ token }) => {
    setToken(token)
    waiting.value = false
    await fetchAllowedActions()
  },
  onTokenUpdate: (token) => {
    setToken(token)
  },
  onDestroy: () => {
    removeAllTokens()
  }
})

onMounted(() => {
  if (!isInIframe()) return
  if (getToken()) {
    fetchAllowedActions()
    return
  }
  waiting.value = true
})
</script>

<style>
.iframe-waiting {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  color: #ccc;
}
</style>
