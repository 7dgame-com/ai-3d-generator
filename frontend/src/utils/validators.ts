/**
 * Validation utilities for AI 3D Generator plugin
 * Requirements: 2.2, 3.1, 4.1, 4.4
 */

/**
 * Validates a prompt text.
 * Returns true if length is between 1 and 500 characters (inclusive).
 */
export function validatePrompt(text: string): boolean {
  return text.length >= 1 && text.length <= 500
}

/**
 * Validates an image file for upload.
 * Accepts MIME types: image/jpeg, image/png, image/webp
 * Max size: 10MB
 */
export function validateImageFile(file: File): { valid: boolean; error?: string } {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp']
  if (!allowedTypes.includes(file.type)) {
    return { valid: false, error: `不支持的文件格式：${file.type}，请上传 JPG、PNG 或 WEBP 图片` }
  }

  const maxSize = 10 * 1024 * 1024 // 10MB
  if (file.size > maxSize) {
    return { valid: false, error: `文件大小超过限制，最大允许 10MB，当前文件 ${(file.size / 1024 / 1024).toFixed(2)}MB` }
  }

  return { valid: true }
}

/**
 * Validates an API key format.
 * Returns true if key starts with 'tsk_' and has length >= 10.
 */
export function validateApiKey(key: string): boolean {
  return key.startsWith('tsk_') && key.length >= 10
}

/**
 * Masks an API key for display.
 * Returns first 8 characters + '****'.
 * If key is shorter than 8 chars, returns full key + '****'.
 */
export function maskApiKey(key: string): string {
  return key.slice(0, 8) + '****'
}
