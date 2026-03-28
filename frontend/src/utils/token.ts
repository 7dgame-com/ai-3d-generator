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
