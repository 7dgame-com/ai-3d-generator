// Feature: ai-3d-generator, Property 8: 任务状态映射

type TaskStatus = 'queued' | 'processing' | 'success' | 'failed' | 'timeout'

/**
 * Maps a Tripo3D task status to its i18n key.
 * Unknown statuses fall back to 'status.queued'.
 */
export function mapStatusToI18nKey(status: string): string {
  const map: Record<TaskStatus, string> = {
    queued: 'status.queued',
    processing: 'status.processing',
    success: 'status.success',
    failed: 'status.failed',
    timeout: 'status.timeout',
  }
  return map[status as TaskStatus] ?? 'status.queued'
}

/**
 * Returns the Element Plus tag type for a given task status.
 */
export function getStatusType(status: string): 'info' | 'success' | 'warning' | 'danger' {
  const map: Record<TaskStatus, 'info' | 'success' | 'warning' | 'danger'> = {
    queued: 'info',
    processing: 'warning',
    success: 'success',
    failed: 'danger',
    timeout: 'warning',
  }
  return map[status as TaskStatus] ?? 'info'
}
