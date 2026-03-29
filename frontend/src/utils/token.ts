const TOKEN_KEY = 'ai-3d-generator-token'
const REFRESH_TOKEN_KEY = 'ai-3d-generator-refresh-token'

/** 是否在 iframe 中运行 */
export function isInIframe(): boolean {
  try {
    return window.self !== window.top
  } catch {
    return true
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token)
}

/**
 * 等待 token 就绪：若 localStorage 中已有 token 则立即 resolve；
 * 否则监听父框架 INIT 消息，收到后从 payload 中取 token 并设置，再 resolve。
 * timeout 超时后以 null resolve，调用方自行处理。
 */
export function waitForToken(timeoutMs = 8000): Promise<string | null> {
  const existing = getToken()
  if (existing) {
    console.log('[waitForToken] found existing token in localStorage')
    return Promise.resolve(existing)
  }

  console.log('[waitForToken] no token, waiting for INIT message...')
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', handler)
      console.warn('[waitForToken] timed out waiting for INIT')
      resolve(null)
    }, timeoutMs)

    function handler(event: MessageEvent) {
      if (event.source !== window.parent) return
      const { type, payload } = (event.data || {}) as { type?: string; payload?: { token?: string } }
      console.log('[waitForToken] received message:', type)
      if (type === 'INIT' && payload?.token) {
        clearTimeout(timer)
        window.removeEventListener('message', handler)
        setToken(payload.token)
        console.log('[waitForToken] INIT received, token set')
        resolve(payload.token)
      }
    }

    window.addEventListener('message', handler)
  })
}

export function removeToken() {
  localStorage.removeItem(TOKEN_KEY)
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY)
}

export function setRefreshToken(token: string) {
  localStorage.setItem(REFRESH_TOKEN_KEY, token)
}

export function removeRefreshToken() {
  localStorage.removeItem(REFRESH_TOKEN_KEY)
}

export function removeAllTokens() {
  removeToken()
  removeRefreshToken()
}

/**
 * 检查 JWT Token 是否过期
 */
export function isTokenExpired(token: string): boolean {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return true
    const payload = JSON.parse(atob(parts[1]))
    if (!payload.exp) return false
    return Math.floor(Date.now() / 1000) >= payload.exp
  } catch {
    return true
  }
}

/**
 * 监听主框架的 postMessage，接收 INIT / TOKEN_UPDATE / DESTROY 消息
 */
export function listenForParentToken(callback: (token: string) => void) {
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return

    const { type, payload } = event.data || {}

    if (type === 'INIT' && payload?.token) {
      setToken(payload.token)
      if (payload.refreshToken) {
        setRefreshToken(payload.refreshToken)
      }
      callback(payload.token)

      window.parent.postMessage({
        type: 'PLUGIN_READY',
        id: `ready-${Date.now()}`
      }, '*')
    }

    if (type === 'TOKEN_UPDATE' && payload?.token) {
      setToken(payload.token)
      if (payload.refreshToken) {
        setRefreshToken(payload.refreshToken)
      }
      callback(payload.token)
    }

    if (type === 'DESTROY') {
      removeAllTokens()
    }
  })
}

/**
 * 通过 postMessage 请求主框架刷新 token
 * 超时后返回 null，由调用方回退到本地刷新
 */
export function requestParentTokenRefresh(): Promise<{
  accessToken: string
  refreshToken?: string
} | null> {
  const timeout = Number(
    import.meta.env.VITE_IFRAME_REFRESH_TIMEOUT
  ) || 3000

  return new Promise((resolve) => {
    let settled = false

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return

      const { type, payload } = event.data || {}
      if (type === 'TOKEN_UPDATE' && payload?.token) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        window.removeEventListener('message', onMessage)
        resolve({
          accessToken: payload.token,
          refreshToken: payload.refreshToken
        })
      }
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      window.removeEventListener('message', onMessage)
      resolve(null)
    }, timeout)

    window.addEventListener('message', onMessage)
    window.parent.postMessage({ type: 'TOKEN_REFRESH_REQUEST' }, '*')
  })
}
