<template>
  <div class="admin-view">
    <!-- API Key 配置 -->
    <el-card class="section-card">
      <template #header>
        <span>{{ t('admin.apiKeyLabel') }}</span>
      </template>

      <el-form :model="form" label-position="top" @submit.prevent>
        <!-- 当前已配置的 Key（脱敏展示） -->
        <el-form-item v-if="currentMaskedKey" :label="t('admin.apiKeyLabel')">
          <el-input :value="currentMaskedKey" disabled />
        </el-form-item>

        <!-- 新 Key 输入框 -->
        <el-form-item :label="currentMaskedKey ? '更新 API Key' : t('admin.apiKeyLabel')">
          <el-input
            v-model="form.newApiKey"
            :placeholder="t('admin.apiKeyPlaceholder')"
            show-password
            clearable
          />
        </el-form-item>

        <el-form-item>
          <el-button
            type="primary"
            :loading="saving"
            :disabled="!form.newApiKey"
            @click="handleSave"
          >
            {{ t('admin.saveBtn') }}
          </el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 全局用量统计 -->
    <el-card class="section-card">
      <template #header>
        <span>{{ t('admin.usageTitle') }}</span>
      </template>

      <div v-if="loadingUsage" class="loading-placeholder">
        <el-skeleton :rows="4" animated />
      </div>

      <template v-else>
        <!-- 总消耗 -->
        <div class="stat-row">
          <span class="stat-label">{{ t('admin.totalCredits') }}</span>
          <span class="stat-value">{{ usage?.totalCredits ?? 0 }}</span>
        </div>

        <!-- 用户排行 -->
        <div class="sub-section">
          <h4>{{ t('admin.ranking') }}</h4>
          <el-table :data="usage?.userRanking ?? []" size="small" stripe>
            <el-table-column prop="userId" :label="t('admin.userId')" width="100" />
            <el-table-column prop="username" label="用户名" />
            <el-table-column prop="credits" :label="t('admin.credits')" width="120" />
          </el-table>
        </div>

        <!-- 每日趋势 -->
        <div class="sub-section">
          <h4>{{ t('admin.dailyTrend') }}</h4>
          <el-table :data="usage?.dailyTrend ?? []" size="small" stripe>
            <el-table-column prop="date" label="日期" />
            <el-table-column prop="credits" :label="t('admin.credits')" width="120" />
          </el-table>
        </div>
      </template>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { usePermissions } from '../composables/usePermissions'
import { validateApiKey, maskApiKey } from '../utils/validators'
import { getAdminConfig, saveAdminConfig, getAdminUsage } from '../api/index'
import type { AdminUsage } from '../api/index'

const { t } = useI18n()
const router = useRouter()
const { fetchAllowedActions, can } = usePermissions()

const currentMaskedKey = ref<string | null>(null)
const form = ref({ newApiKey: '' })
const saving = ref(false)
const loadingUsage = ref(false)
const usage = ref<AdminUsage | null>(null)

onMounted(async () => {
  // 权限守卫
  await fetchAllowedActions()
  if (!can('admin-config')) {
    router.replace('/no-permission')
    return
  }

  // 加载配置和用量
  loadConfig()
  loadUsage()
})

async function loadConfig() {
  try {
    const res = await getAdminConfig()
    currentMaskedKey.value = res.data.apiKeyMasked
  } catch {
    // 未配置时静默处理
  }
}

async function loadUsage() {
  loadingUsage.value = true
  try {
    const res = await getAdminUsage()
    usage.value = res.data
  } catch {
    ElMessage.error(t('errors.serverError'))
  } finally {
    loadingUsage.value = false
  }
}

async function handleSave() {
  const key = form.value.newApiKey.trim()

  if (!validateApiKey(key)) {
    ElMessage.error(t('errors.apiKeyInvalid'))
    return
  }

  saving.value = true
  try {
    await saveAdminConfig(key)
    currentMaskedKey.value = maskApiKey(key)
    form.value.newApiKey = ''
    ElMessage.success(t('common.success'))
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status
    if (status === 422) {
      ElMessage.error(t('errors.apiKeyConnectFailed'))
    } else {
      ElMessage.error(t('errors.serverError'))
    }
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.admin-view {
  padding: 20px;
  max-width: 800px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.section-card {
  width: 100%;
}

.loading-placeholder {
  padding: 12px 0;
}

.stat-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
}

.stat-label {
  font-size: 14px;
  color: var(--el-text-color-secondary);
}

.stat-value {
  font-size: 24px;
  font-weight: 600;
  color: var(--el-color-primary);
}

.sub-section {
  margin-top: 20px;
}

.sub-section h4 {
  margin: 0 0 10px;
  font-size: 14px;
  color: var(--el-text-color-regular);
}
</style>
