import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12 // 96-bit IV recommended for GCM
const AUTH_TAG_LENGTH = 16

function getKey(): Buffer {
  const keyHex = process.env.CRYPTO_KEY
  if (!keyHex) {
    throw new Error('CRYPTO_KEY environment variable is not set')
  }
  if (keyHex.length !== 64) {
    throw new Error('CRYPTO_KEY must be 64 hex characters (32 bytes)')
  }
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error('CRYPTO_KEY must be a valid hex string')
  }
  return Buffer.from(keyHex, 'hex')
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * @returns base64-encoded string containing iv_hex:authTag_hex:ciphertext_hex
 */
export function encrypt(plaintext: string): string {
  const key = getKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  const combined = `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`
  return Buffer.from(combined).toString('base64')
}

/**
 * Decrypts a base64-encoded string produced by encrypt().
 * @returns the original plaintext string
 */
export function decrypt(ciphertext: string): string {
  const key = getKey()

  let combined: string
  try {
    combined = Buffer.from(ciphertext, 'base64').toString('utf8')
  } catch {
    throw new Error('Invalid ciphertext: failed to decode base64')
  }

  const parts = combined.split(':')
  if (parts.length !== 3) {
    throw new Error('Invalid ciphertext format: expected iv:authTag:ciphertext')
  }

  const [ivHex, authTagHex, encryptedHex] = parts

  if (ivHex.length !== IV_LENGTH * 2) {
    throw new Error('Invalid ciphertext: IV length mismatch')
  }
  if (authTagHex.length !== AUTH_TAG_LENGTH * 2) {
    throw new Error('Invalid ciphertext: auth tag length mismatch')
  }

  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')
  const encrypted = Buffer.from(encryptedHex, 'hex')

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)

  try {
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
    return decrypted.toString('utf8')
  } catch {
    throw new Error('Decryption failed: invalid key or corrupted ciphertext')
  }
}
