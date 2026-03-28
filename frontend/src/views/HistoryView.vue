<template>
  <div class="history-view">
    <!-- 用量统计卡片 -->
    <div class="stats-row">
      <el-card class="stat-card">
        <div class="stat-value">{{ summary?.totalCredits ?? 0 }}</div>
        <div class="stat-label">{{ t('history.totalCredits') }}</div>
      </el-card>
      <el-card class="stat-card">
        <div class="stat-value">{{ summary?.monthCredits ?? 0 }}</div>
        <div class="stat-label">{{ t('history.monthCredits') }}</div>
      </el-card>
      <el-card class="stat-card">
        <div class="stat-value">{{ summary?.taskCount ?? 0 }}</div>
        <div class="stat-label">{{ t('history.taskCount') }}</div>
      </el-card>
    </div>

    <!-- 筛选器 -->
    <el-card class="section-card">
      <div class="filter-row">
        <el-date-picker
          v-model="dateRange"
          type="daterange"
          :start-placeholder="t('history.filterByDate')"
          :end-placeholder="t('history.filterByDate')"
          value-format="YYYY-MM-DD"
          style="width: 280px"
        />
        <el-select
          v-model="typeFilter"
          style="width: 160px"
          :placeholder="t('history.filterByType')"
        >
          <el-option :label="t('history.allTypes')" value="" />
          <el-option :label="t('history.textToModel')" value="text_to_model" />
          <el-option :label="t('history.imageToModel')" value="image_to_model" />
        </el-select>
        <el-button type="primary" :loading="loadingHistory" @click="loadHistory">
          {{ t('common.confirm') }}
        </el-button>
      </div>
    </el-card>

    <!-- 历史列表 -->
    <el-card class="section-card">
      <template #header>
        <span>{{ t('history.title') }}</span>
      </template>

      <el-table
        v-loading="loadingHistory"
        :data="historyList"
        stripe
        style="width: 100%"
      >
        <el-table-column :label="t('history.type')" width="130">
          <template #default="{ row }">
            <el-tag :type="row.type === 'text_to_model' ? 'primary' : 'success'" size="small">
              {{ row.type === 'text_to_model' ? t('history.textToModel') : t('history.imageToModel') }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column :label="t('history.prompt')">
          <template #default="{ row }">
            <span class="prompt-text">{{ truncate(row.prompt) }}</span>
          </template>
        </el-table-column>

        <el-table-column :label="t('history.creditsUsed')" prop="creditsUsed" width="130" />

        <el-table-column :label="t('history.createdAt')" prop="createdAt" width="180">
          <template #default="{ row }">
            {{ formatDate(row.createdAt) }}
          </template>
        </el-table-column>

        <el-table-column :label="t('history.status')" width="120">
          <template #default="{ row }">
            <el-tag :type="getStatusType(row.status)" size="small">
              {{ t(mapStatusToI18nKey(row.status)) }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="!loadingHistory && historyList.length === 0" class="empty-tip">
        {{ t('generator.noTasks') }}
      </div>
    </el-card>

    <!-- 每日趋势 -->
    <el-card class="section-card">
      <template #header>
        <span>{{ t('admin.dailyTrend') }}</span>
      </template>

      <el-table :data="summary?.dailyTrend ?? []" size="small" stripe style="width: 100%">
        <el-table-column prop="date" label="日期" />
        <el-table-column prop="credits" :label="t('admin.credits')" width="120" />
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { usePermissions } from '../composables/usePermissions'
import { getUsageSummary, getUsageHistory } from '../api/index'
import { mapStatusToI18nKey, getStatusType } from '../utils/statusMapper'
import type { UsageSummary, UsageHistoryItem } from '../api/index'

const { t } = useI18n()
const router = useRouter()
const { fetchAllowedActions, can } = usePermissions()

const summary = ref<UsageSummary | null>(null)
const historyList = ref<UsageHistoryItem[]>([])
const loadingHistory = ref(false)
const dateRange = ref<[string, string] | null>(null)
const typeFilter = ref<'' | 'text_to_model' | 'image_to_model'>('')

onMounted(async () => {
  await fetchAllowedActions()
  if (!can('view-usage')) {
    router.replace('/no-permission')
    return
  }
  loadSummary()
  loadHistory()
})

async function loadSummary() {
  try {
    const res = await getUsageSummary()
    summary.value = res.data
  } catch {
    ElMessage.error(t('errors.serverError'))
  }
}

async function loadHistory() {
  loadingHistory.value = true
  try {
    const params: {
      startDate?: string
      endDate?: string
      type?: 'text_to_model' | 'image_to_model'
    } = {}
    if (dateRange.value) {
      params.startDate = dateRange.value[0]
      params.endDate = dateRange.value[1]
    }
    if (typeFilter.value) {
      params.type = typeFilter.value
    }
    const res = await getUsageHistory(params)
    historyList.value = res.data.data
  } catch {
    ElMessage.error(t('errors.serverError'))
  } finally {
    loadingHistory.value = false
  }
}

function truncate(text: string | null, max = 60): string {
  if (!text) return '—'
  return text.length > max ? text.slice(0, max) + '…' : text
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString()
}
</script>

<style scoped>
.history-view {
  padding: 20px;
  max-width: 960px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.stats-row {
  display: flex;
  gap: 16px;
}

.stat-card {
  flex: 1;
  text-align: center;
}

.stat-value {
  font-size: 28px;
  font-weight: 600;
  color: var(--el-color-primary);
}

.stat-label {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  margin-top: 4px;
}

.section-card {
  width: 100%;
}

.filter-row {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}

.prompt-text {
  color: var(--el-text-color-regular);
  font-size: 13px;
}

.empty-tip {
  text-align: center;
  color: var(--el-text-color-secondary);
  padding: 24px 0;
  font-size: 14px;
}
</style>
