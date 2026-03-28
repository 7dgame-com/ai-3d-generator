import { ref, onMounted, onBeforeUnmount } from 'vue'

// ── Types ───────────────────────────────────────────────────

/** Standard message envelope for iframe ↔ host communication. */
export interface StandardMessage {
  type: string
  id: string
  payload?: Record<string, unknown>
  requestId?: string
}

/** Callback signature for registered message handlers. */
export type MessageHandler = (payload: unknown, msg: StandardMessage) => void

export interface UsePluginMessageBridgeOptions {
  /** INIT 消息回调 */
  onInit?: (payload: { token: string; config: Record<string, unknown> }) => void
  /** TOKEN_UPDATE 消息回调 */
  onTokenUpdate?: (token: string) => void
  /** DESTROY 消息回调 */
  onDestroy?: () => void
}

export interface UsePluginMessageBridgeReturn {
  /** 插件是否已完成握手（收到 INIT） */
  isReady: import('vue').Ref<boolean>
  /** 当前 JWT token */
  token: import('vue').Ref<string | null>
  /** 插件配置（来自 INIT payload） */
  config: import('vue').Ref<Record<string, unknown>>
  /** 发送消息到主系统 */
  postMessage: (type: string, payload?: Record<string, unknown>) => void
  /** 发送 RESPONSE 消息，自动附加 requestId */
  postResponse: (payload: Record<string, unknown>, requestId?: string) => void
  /** 注册自定义消息处理器 */
  onMessage: (type: string, handler: MessageHandler) => void
}

// ── Helpers ─────────────────────────────────────────────────

/** Generate a unique message ID. */
function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

// ── Composable ──────────────────────────────────────────────

/**
 * Unified plugin communication bridge composable.
 *
 * Merges token/config state management (from usePluginBridge) with
 * postMessage/postResponse/onMessage routing (from useMessageBridge).
 *
 * Lifecycle:
 *  1. onMounted  → register message listener → send PLUGIN_READY
 *  2. INIT       → store token/config → isReady = true → call onInit
 *  3. TOKEN_UPDATE → update token → call onTokenUpdate
 *  4. DESTROY    → clear state → call onDestroy
 *  5. REQUEST    → track lastRequestId → route to user handler
 *  6. onBeforeUnmount → remove all event listeners
 */
export function usePluginMessageBridge(
  options?: UsePluginMessageBridgeOptions,
): UsePluginMessageBridgeReturn {
  const isReady = ref(false)
  const token = ref<string | null>(null)
  const config = ref<Record<string, unknown>>({})

  const handlers = new Map<string, MessageHandler>()

  /** The id of the last received REQUEST, used for RESPONSE pairing. */
  let lastRequestId: string | undefined

  // ── Outgoing ────────────────────────────────────────────

  /** Send a message to the parent window using the standard envelope format. */
  const postMessage = (type: string, payload?: Record<string, unknown>) => {
    const msg: StandardMessage = { type, id: genId() }
    if (payload !== undefined) {
      msg.payload = payload
    }
    window.parent.postMessage(msg, '*')
  }

  /**
   * Send a RESPONSE message.
   * If `requestId` is provided it is used directly; otherwise the
   * automatically tracked `lastRequestId` is attached.
   */
  const postResponse = (
    payload: Record<string, unknown>,
    requestId?: string,
  ) => {
    const msg: StandardMessage = { type: 'RESPONSE', id: genId(), payload }
    const rid = requestId ?? lastRequestId
    if (rid !== undefined) {
      msg.requestId = rid
    }
    window.parent.postMessage(msg, '*')
  }

  // ── Incoming ────────────────────────────────────────────

  /** Register a handler for a specific incoming message type. */
  const onMessage = (type: string, handler: MessageHandler) => {
    handlers.set(type, handler)
  }

  // ── Built-in handlers ───────────────────────────────────

  function handleInit(payload: Record<string, unknown>) {
    token.value = (payload.token as string) ?? null
    config.value = (payload.config as Record<string, unknown>) ?? {}
    isReady.value = true
    options?.onInit?.({
      token: token.value ?? '',
      config: config.value,
    })
  }

  function handleTokenUpdate(payload: Record<string, unknown>) {
    const newToken = (payload.token as string) ?? null
    token.value = newToken
    options?.onTokenUpdate?.(newToken ?? '')
  }

  function handleDestroy() {
    options?.onDestroy?.()
    isReady.value = false
    token.value = null
    config.value = {}
  }

  // ── Core message router ─────────────────────────────────

  function handleMessage(event: MessageEvent) {
    try {
      if (event.source !== window.parent) return

      const msg = event.data as StandardMessage
      if (!msg || typeof msg.type !== 'string') return

      // Track REQUEST id for RESPONSE pairing
      if (msg.type === 'REQUEST') {
        lastRequestId = msg.id
      }

      // Built-in protocol messages
      switch (msg.type) {
        case 'INIT':
          handleInit((msg.payload as Record<string, unknown>) ?? {})
          break
        case 'TOKEN_UPDATE':
          handleTokenUpdate((msg.payload as Record<string, unknown>) ?? {})
          break
        case 'DESTROY':
          handleDestroy()
          break
      }

      // User-registered handlers (also fires for INIT/TOKEN_UPDATE/DESTROY
      // if the consumer registered one, and for REQUEST, EVENT, etc.)
      const handler = handlers.get(msg.type)
      if (handler) {
        handler(msg.payload, msg)
      }
    } catch (e) {
      console.error('[PluginMessageBridge]', e)
    }
  }

  // ── Lifecycle ───────────────────────────────────────────

  onMounted(() => {
    window.addEventListener('message', handleMessage)
    postMessage('PLUGIN_READY')
  })

  onBeforeUnmount(() => {
    window.removeEventListener('message', handleMessage)
  })

  return {
    isReady,
    token,
    config,
    postMessage,
    postResponse,
    onMessage,
  }
}
