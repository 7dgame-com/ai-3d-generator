<template>
  <div class="generator-view">
    <!-- API Key 未配置 - 全屏遮罩，不可关闭 -->
    <div v-if="apiKeyConfigured === false" class="api-key-blocker">
      <div class="api-key-blocker__card">
        <div class="api-key-blocker__icon">⚠️</div>
        <h2 class="api-key-blocker__title">{{ t('generator.apiKeyBlockerTitle') }}</h2>
        <p class="api-key-blocker__desc">{{ t('generator.apiKeyBlockerDesc') }}</p>
        <p class="api-key-blocker__hint">{{ t('generator.apiKeyBlockerHint') }}</p>
        <!-- 管理员入口：root/admin 角色时显示 -->
        <div v-if="isRoot" class="api-key-blocker__admin">
          <el-button type="primary" size="large" @click="router.push('/admin')">
            {{ t('generator.apiKeyBlockerAdminBtn') }}
          </el-button>
        </div>
      </div>
    </div>

    <!-- 生成区域 -->
    <el-card class="section-card">
      <el-tabs v-model="activeTab">
        <!-- 文本生成 Tab -->
        <el-tab-pane :label="t('generator.textTab')" name="text">
          <el-form @submit.prevent="handleTextGenerate">
            <el-form-item :label="t('generator.promptLabel')">
              <el-input
                v-model="prompt"
                type="textarea"
                :rows="4"
                :maxlength="500"
                show-word-limit
                :placeholder="t('generator.promptPlaceholder')"
              />
            </el-form-item>
            <el-form-item>
              <el-button
                type="primary"
                native-type="submit"
                :loading="generatingText"
                :disabled="!canGenerate || !isPromptValid"
              >
                {{ t('generator.generateBtn') }}
              </el-button>
              <span v-if="!can('generate-model')" class="hint-text">
                {{ t('generator.noPermission') }}
              </span>
            </el-form-item>
          </el-form>
        </el-tab-pane>

        <!-- 图片生成 Tab -->
        <el-tab-pane :label="t('generator.imageTab')" name="image">
          <el-upload
            class="image-uploader"
            drag
            :auto-upload="false"
            accept="image/jpeg,image/png,image/webp"
            :on-change="handleImageChange"
            :on-remove="handleImageRemove"
            :limit="1"
            :file-list="imageFileList"
          >
            <el-icon class="el-icon--upload"><upload-filled /></el-icon>
            <div class="el-upload__text">{{ t('generator.uploadArea') }}</div>
            <template #tip>
              <div class="el-upload__tip">{{ t('generator.uploadHint') }}</div>
            </template>
          </el-upload>

          <div v-if="imageError" class="image-error">{{ imageError }}</div>

          <el-form-item style="margin-top: 16px;">
            <el-button
              type="primary"
              :loading="generatingImage"
              :disabled="!canGenerate || !selectedImageFile"
              @click="handleImageGenerate"
            >
              {{ t('generator.generateBtn') }}
            </el-button>
            <span v-if="!can('generate-model')" class="hint-text">
              {{ t('generator.noPermission') }}
            </span>
          </el-form-item>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <!-- 任务列表 -->
    <el-card class="section-card">
      <template #header>
        <span>{{ t('generator.taskList') }}</span>
      </template>

      <div v-if="loadingTasks" class="loading-placeholder">
        <el-skeleton :rows="3" animated />
      </div>

      <el-empty v-else-if="tasks.length === 0" :description="t('generator.noTasks')" />

      <div v-else class="task-list">
        <div v-for="task in tasks" :key="task.taskId" class="task-item">
          <div class="task-header">
            <el-tag size="small" :type="getStatusType(task.status)">
              {{ t(mapStatusToI18nKey(task.status)) }}
              <span v-if="task.status === 'processing' && task.progress > 0">
                {{ task.progress }}%
              </span>
            </el-tag>
            <el-tag size="small" type="info" style="margin-left: 6px;">
              {{ task.type === 'text_to_model' ? t('history.textToModel') : t('history.imageToModel') }}
            </el-tag>
          </div>

          <div v-if="task.prompt" class="task-prompt">
            {{ task.prompt.slice(0, 80) }}{{ task.prompt.length > 80 ? '...' : '' }}
          </div>

          <!-- 进度条（仅 processing 状态显示） -->
          <el-progress
            v-if="task.status === 'processing'"
            :percentage="task.progress"
            :stroke-width="6"
            style="margin-top: 8px;"
          />

          <!-- 操作按钮 -->
          <div class="task-actions">
            <!-- 下载按钮 -->
            <el-button
              v-if="can('download-model') && task.status === 'success'"
              size="small"
              type="success"
              @click="handleDownload(task.taskId)"
            >
              {{ t('task.download') }}
            </el-button>

            <!-- 上传到主系统按钮 -->
            <el-button
              v-if="can('upload-to-main') && task.status === 'success' && !task.metaId"
              size="small"
              type="primary"
              :loading="uploadingTaskId === task.taskId"
              @click="handleUploadToMain(task)"
            >
              {{ t('task.uploadToMain') }}
            </el-button>

            <!-- 上传进度 -->
            <span v-if="uploadingTaskId === task.taskId" class="upload-progress">
              {{ uploadProgress }}%
            </span>

            <!-- 已上传标记 -->
            <el-tag
              v-if="task.metaId"
              size="small"
              type="success"
              effect="plain"
            >
              ✓ 已上传
            </el-tag>
          </div>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { waitForToken } from '../utils/token'
import { UploadFilled } from '@element-plus/icons-vue'
import type { UploadFile } from 'element-plus'
import { usePermissions } from '../composables/usePermissions'
import { useTaskPoller } from '../composables/useTaskPoller'
import { useUploadService } from '../composables/useUploadService'
import { validatePrompt, validateImageFile } from '../utils/validators'
import { mapStatusToI18nKey, getStatusType } from '../utils/statusMapper'
import {
  createTask,
  listTasks,
  getAdminConfig,
  getDownloadProxyUrl,
  verifyToken,
} from '../api/index'
import type { Task } from '../api/index'

const { t } = useI18n()
const router = useRouter()
const { fetchAllowedActions, can } = usePermissions()
const { startPolling, stopAllPolling } = useTaskPoller()
const { uploadToCOS } = useUploadService()

// ── State ──────────────────────────────────────────────────────────────────

const activeTab = ref<'text' | 'image'>('text')
const prompt = ref('')
const generatingText = ref(false)
const generatingImage = ref(false)
const loadingTasks = ref(false)
const tasks = ref<Task[]>([])
const apiKeyConfigured = ref(false)
const isRoot = ref(false)

// Image upload
const selectedImageFile = ref<File | null>(null)
const imageFileList = ref<UploadFile[]>([])
const imageError = ref<string | null>(null)

// Upload to main
const uploadingTaskId = ref<string | null>(null)
const uploadProgress = ref(0)

// ── Computed ───────────────────────────────────────────────────────────────

const isPromptValid = computed(() => validatePrompt(prompt.value))

const canGenerate = computed(
  () => can('generate-model') && apiKeyConfigured.value
)

// ── Lifecycle ──────────────────────────────────────────────────────────────

onMounted(async () => {
  const token = await waitForToken()
  console.log('[GeneratorView] waitForToken resolved:', token ? 'has token' : 'null')
  if (!token) return
  await fetchAllowedActions()
  await Promise.all([loadAdminConfig(), loadTasks(), loadCurrentUser()])
})

onUnmounted(() => {
  stopAllPolling()
})

// ── Methods ────────────────────────────────────────────────────────────────

async function loadCurrentUser() {
  try {
    const res = await verifyToken()
    const roles: string[] = res.data?.roles ?? (res.data as any)?.data?.roles ?? []
    isRoot.value = roles.includes('root')
  } catch {
    isRoot.value = false
  }
}

async function loadAdminConfig() {
  try {
    const res = await getAdminConfig()
    apiKeyConfigured.value = res.data.configured
  } catch {
    apiKeyConfigured.value = false
  }
}

async function loadTasks() {
  loadingTasks.value = true
  try {
    const res = await listTasks({ page: 1, pageSize: 50 })
    tasks.value = res.data.data
    // Start polling for any in-progress tasks
    tasks.value.forEach((task) => {
      if (task.status === 'queued' || task.status === 'processing') {
        startPolling(task.taskId, (updated) => updateTask(updated))
      }
    })
  } catch {
    ElMessage.error(t('errors.serverError'))
  } finally {
    loadingTasks.value = false
  }
}

function updateTask(updated: Task) {
  const idx = tasks.value.findIndex((item) => item.taskId === updated.taskId)
  if (idx !== -1) {
    tasks.value[idx] = updated
  }
}

async function handleTextGenerate() {
  if (!canGenerate.value || !isPromptValid.value) return

  generatingText.value = true
  try {
    const res = await createTask({ type: 'text_to_model', prompt: prompt.value })
    const newTask = res.data
    tasks.value.unshift(newTask)
    startPolling(newTask.taskId, (updated) => updateTask(updated))
    prompt.value = ''
    ElMessage.success(t('common.success'))
  } catch {
    ElMessage.error(t('errors.generateFailed'))
  } finally {
    generatingText.value = false
  }
}

function handleImageChange(file: UploadFile) {
  imageError.value = null
  if (!file.raw) return

  const validation = validateImageFile(file.raw)
  if (!validation.valid) {
    imageError.value = validation.error ?? null
    imageFileList.value = []
    selectedImageFile.value = null
    return
  }

  selectedImageFile.value = file.raw
  imageFileList.value = [file]
}

function handleImageRemove() {
  selectedImageFile.value = null
  imageFileList.value = []
  imageError.value = null
}

async function handleImageGenerate() {
  if (!canGenerate.value || !selectedImageFile.value) return

  const file = selectedImageFile.value
  const validation = validateImageFile(file)
  if (!validation.valid) {
    ElMessage.error(validation.error)
    return
  }

  generatingImage.value = true
  try {
    const base64 = await fileToBase64(file)
    const mimeType = file.type as 'image/jpeg' | 'image/png' | 'image/webp'
    const res = await createTask({ type: 'image_to_model', imageBase64: base64, mimeType })
    const newTask = res.data
    tasks.value.unshift(newTask)
    startPolling(newTask.taskId, (updated) => updateTask(updated))
    selectedImageFile.value = null
    imageFileList.value = []
    ElMessage.success(t('common.success'))
  } catch {
    ElMessage.error(t('errors.generateFailed'))
  } finally {
    generatingImage.value = false
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      // Strip the data URL prefix (e.g. "data:image/jpeg;base64,")
      const base64 = result.split(',')[1]
      resolve(base64)
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function handleDownload(taskId: string) {
  const url = getDownloadProxyUrl(taskId, 'glb')
  window.open(url, '_blank')
}

async function handleUploadToMain(task: Task) {
  if (uploadingTaskId.value) return

  uploadingTaskId.value = task.taskId
  uploadProgress.value = 0

  try {
    await uploadToCOS(task.taskId, task.prompt, (percent) => {
      uploadProgress.value = percent
    })
    // Refresh the task to get updated metaId
    const idx = tasks.value.findIndex((item) => item.taskId === task.taskId)
    if (idx !== -1) {
      tasks.value[idx] = { ...tasks.value[idx], metaId: -1 } // placeholder until reload
    }
    await loadTasks()
    ElMessage.success(t('common.success'))
  } catch {
    ElMessage.error(t('errors.uploadFailed'))
  } finally {
    uploadingTaskId.value = null
    uploadProgress.value = 0
  }
}
</script>

<style scoped>
.generator-view {
  padding: 20px;
  max-width: 900px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.api-key-alert {
  margin-bottom: 0;
}

.api-key-blocker {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(4px);
}

.api-key-blocker__card {
  background: #fff;
  border-radius: 16px;
  padding: 48px 56px;
  max-width: 480px;
  width: 90%;
  text-align: center;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.3);
}

.api-key-blocker__icon {
  font-size: 56px;
  line-height: 1;
  margin-bottom: 20px;
}

.api-key-blocker__title {
  font-size: 22px;
  font-weight: 700;
  color: #1a1a1a;
  margin: 0 0 16px;
}

.api-key-blocker__desc {
  font-size: 15px;
  color: #555;
  line-height: 1.7;
  margin: 0 0 12px;
}

.api-key-blocker__hint {
  font-size: 13px;
  color: #999;
  margin: 0;
}

.api-key-blocker__admin {
  margin-top: 28px;
  padding-top: 24px;
  border-top: 1px solid #eee;
}

.section-card {
  width: 100%;
}

.image-uploader {
  width: 100%;
}

.image-error {
  color: var(--el-color-danger);
  font-size: 12px;
  margin-top: 6px;
}

.hint-text {
  margin-left: 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.loading-placeholder {
  padding: 12px 0;
}

.task-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.task-item {
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
  padding: 12px 16px;
}

.task-header {
  display: flex;
  align-items: center;
  margin-bottom: 6px;
}

.task-prompt {
  font-size: 13px;
  color: var(--el-text-color-regular);
  margin-top: 4px;
  word-break: break-all;
}

.task-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.upload-progress {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
