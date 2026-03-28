import { getTask } from '../api/index'
import type { Task } from '../api/index'

const POLL_INTERVAL_MS = 3000
const TERMINAL_STATUSES = new Set(['success', 'failed', 'timeout'])

export function useTaskPoller() {
  const intervals = new Map<string, number>()

  function startPolling(taskId: string, onUpdate: (task: Task) => void): void {
    if (intervals.has(taskId)) return

    const intervalId = window.setInterval(async () => {
      try {
        const res = await getTask(taskId)
        const task = res.data
        onUpdate(task)

        if (TERMINAL_STATUSES.has(task.status)) {
          stopPolling(taskId)
        }
      } catch (err) {
        console.error(`[useTaskPoller] Failed to poll task ${taskId}:`, err)
      }
    }, POLL_INTERVAL_MS)

    intervals.set(taskId, intervalId)
  }

  function stopPolling(taskId: string): void {
    const intervalId = intervals.get(taskId)
    if (intervalId !== undefined) {
      window.clearInterval(intervalId)
      intervals.delete(taskId)
    }
  }

  function stopAllPolling(): void {
    intervals.forEach((intervalId) => window.clearInterval(intervalId))
    intervals.clear()
  }

  return { startPolling, stopPolling, stopAllPolling }
}
