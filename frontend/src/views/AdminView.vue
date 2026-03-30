<template>
  <div class="admin-view">
    <!-- API Key 配置（按提供商分组） -->
    <el-card class="section-card">
      <template #header>
        <span>{{ t('admin.apiKeyLabel') }}</span>
      </template>

      <el-skeleton v-if="loadingProviders" :rows="2" animated />

      <el-tabs v-else-if="enabledProviders.length > 1" v-model="activeProviderTab">
        <el-tab-pane
          v-for="pid in enabledProviders"
          :key="pid"
          :label="t(`provider.${pid}`, pid)"
          :name="pid"
        >
          <el-form label-position="top" @submit.prevent>
            <el-form-item v-if="providerMaskedKeys[pid]" :label="t('admin.apiKeyLabel')">
              <el-input :value="providerMaskedKeys[pid]" disabled />
            </el-form-item>
            <el-form-item :label="providerMaskedKeys[pid] ? '更新 API Key' : t('admin.apiKeyLabel')">
              <el-input
                v-model="providerNewKeys[pid]"
                :placeholder="t('admin.apiKeyPlaceholder')"
                show-password
                clearable
              />
            </el-form-item>
            <el-form-item>
              <el-button
                type="primary"
                :loading="savingProvider === pid"
                :disabled="!providerNewKeys[pid]"
                @click="handleSave(pid)"
              >
                {{ t('admin.saveBtn') }}
              </el-button>
            </el-form-item>
          </el-form>
        </el-tab-pane>
      </el-tabs>

      <template v-else-if="enabledProviders.length === 1">
        <el-form label-position="top" @submit.prevent>
          <el-form-item v-if="providerMaskedKeys[enabledProviders[0]]" :label="t('admin.apiKeyLabel')">
            <el-input :value="providerMaskedKeys[enabledProviders[0]]" disabled />
          </el-form-item>
          <el-form-item :label="providerMaskedKeys[enabledProviders[0]] ? '更新 API Key' : t('admin.apiKeyLabel')">
            <el-input
              v-model="providerNewKeys[enabledProviders[0]]"
              :placeholder="t('admin.apiKeyPlaceholder')"
              show-password
              clearable
            />
          </el-form-item>
          <el-form-item>
            <el-button
              type="primary"
              :loading="savingProvider === enabledProviders[0]"
              :disabled="!providerNewKeys[enabledProviders[0]]"
              @click="handleSave(enabledProviders[0])"
            >
              {{ t('admin.saveBtn') }}
            </el-button>
          </el-form-item>
        </el-form>
      </template>
    </el-card>

    <!-- 账户余额（按提供商分组） -->
    <el-card class="section-card">
      <template #header>
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span>{{ t('admin.balanceTitle') }}</span>
          <el-button size="small" :loading="loadingBalance" @click="loadAllBalances">{{ t('admin.balanceRefresh') }}</el-button>
        </div>
      </template>

      <div v-if="loadingBalance" class="loading-placeholder"><el-skeleton :rows="2" animated /></div>

      <template v-else>
        <div
          v-for="pid in enabledProviders"
          :key="pid"
          class="provider-balance-section"
        >
          <h4 v-if="enabledProviders.length > 1" class="provider-section-title">{{ t(`provider.${pid}`, pid) }}</h4>
          <template v-if="providerBalances[pid]">
            <div class="stat-row">
              <span class="stat-label">{{ t('admin.balanceAvailable') }}</span>
              <span class="stat-value" style="color:#67c23a;font-size:22px;">{{ providerBalances[pid]!.available }}</span>
            </div>
            <div class="stat-row" style="margin-top:8px;">
              <span class="stat-label">{{ t('admin.balanceFrozen') }}</span>
              <span class="stat-value" style="color:#e6a23c;">{{ providerBalances[pid]!.frozen }}</span>
            </div>
          </template>
          <el-empty v-else :description="t('admin.balanceUnavailable')" :image-size="60" />
        </div>
      </template>
    </el-card>

    <!-- 充值表单 -->
    <el-card class="section-card">
      <template #header>
        <span>充值</span>
      </template>
      <el-form :model="rechargeForm" label-position="top" @submit.prevent>
        <el-form-item :label="t('provider.label')">
          <el-select v-model="rechargeForm.provider_id" :placeholder="t('provider.select')" style="width: 200px;">
            <el-option
              v-for="pid in enabledProviders"
              :key="pid"
              :label="t(`provider.${pid}`, pid)"
              :value="pid"
            />
          </el-select>
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
        <div class="stat-row">
          <span class="stat-label">{{ t('admin.totalCredits') }}</span>
          <span class="stat-value">{{ usage?.totalCredits ?? 0 }}</span>
        </div>

        <div class="sub-section">
          <h4>{{ t('admin.ranking') }}</h4>
          <el-table :data="usage?.userRanking ?? []" size="small" stripe>
            <el-table-column prop="userId" :label="t('admin.userId')" width="100" />
            <el-table-column prop="username" label="用户名" />
            <el-table-column prop="credits" :label="t('admin.credits')" width="120" />
          </el-table>
        </div>

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
import { ref, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { waitForToken } from '../utils/token'
import { validateApiKey, maskApiKey } from '../utils/validators'
import { getAdminConfig, saveAdminConfig, getAdminUsage, getAdminBalance, getEnabledProviders, verifyToken } from '../api/index'
import type { AdminUsage } from '../api/index'

const { t } = useI18n()
const router = useRouter()

const enabledProviders = ref<string[]>([])
const loadingProviders = ref(true)
const activeProviderTab = ref<string>('')
const providerMaskedKeys = reactive<Record<string, string | null>>({})
const providerNewKeys = reactive<Record<string, string>>({})
const savingProvider = ref<string | null>(null)
const loadingUsage = ref(false)
const loadingBalance = ref(false)
const usage = ref<AdminUsage | null>(null)
const providerBalances = reactive<Record<string, { available: number; frozen: number } | null>>({})
const rechargeForm = ref({ provider_id: '' })

onMounted(async () => {
  const token = await waitForToken()
  if (!token) return

  try {
    const res = await verifyToken()
    const roles: string[] = res.data?.roles ?? (res.data as any)?.data?.roles ?? []
    const isRoot = roles.includes('root')
    if (!isRoot) {
      router.replace('/no-permission')
      return
    }
  } catch {
    router.replace('/no-permission')
    return
  }

  await loadEnabledProviders()
  loadUsage()
  loadAllBalances()
})

async function loadEnabledProviders() {
  loadingProviders.value = true
  try {
    const res = await getEnabledProviders()
    enabledProviders.value = res.data.providers ?? []
    if (enabledProviders.value.length > 0) {
      activeProviderTab.value = enabledProviders.value[0]
      rechargeForm.value.provider_id = enabledProviders.value[0]
      for (const pid of enabledProviders.value) {
        providerNewKeys[pid] = ''
      }
    }
    await loadAllConfigs()
  } catch {
    enabledProviders.value = []
  } finally {
    loadingProviders.value = false
  }
}

async function loadAllConfigs() {
  for (const pid of enabledProviders.value) {
    try {
      const res = await getAdminConfig(pid)
      providerMaskedKeys[pid] = res.data.apiKeyMasked
    } catch {
      providerMaskedKeys[pid] = null
    }
  }
}

async function loadAllBalances() {
  loadingBalance.value = true
  try {
    for (const pid of enabledProviders.value) {
      try {
        const res = await getAdminBalance(pid)
        if (res.data.configured && res.data.available !== undefined) {
          providerBalances[pid] = { available: res.data.available, frozen: res.data.frozen ?? 0 }
        } else {
          providerBalances[pid] = null
        }
      } catch {
        providerBalances[pid] = null
      }
    }
  } finally {
    loadingBalance.value = false
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

async function handleSave(providerId: string) {
  const key = (providerNewKeys[providerId] ?? '').trim()
  if (!validateApiKey(key)) {
    ElMessage.error(t('errors.apiKeyInvalid'))
    return
  }

  savingProvider.value = providerId
  try {
    await saveAdminConfig(key, providerId)
    providerMaskedKeys[providerId] = maskApiKey(key)
    providerNewKeys[providerId] = ''
    ElMessage.success(t('common.success'))
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status
    if (status === 422) {
      ElMessage.error(t('errors.apiKeyConnectFailed'))
    } else {
      ElMessage.error(t('errors.serverError'))
    }
  } finally {
    savingProvider.value = null
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

.provider-balance-section {
  margin-bottom: 24px;
}

.provider-section-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  margin: 0 0 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--el-border-color-light);
}
</style>
