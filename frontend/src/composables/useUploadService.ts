import { ref } from 'vue'
import type { Ref } from 'vue'
import COS from 'cos-js-sdk-v5'
import { mainApi, getDownloadUrl, updateTaskMeta } from '../api/index'

interface CloudConfig {
  bucket: string
  region: string
}

interface StsCredentials {
  tmpSecretId: string
  tmpSecretKey: string
  sessionToken: string
}

interface StsToken {
  credentials: StsCredentials
  expiredTime: number
}

interface FileRecord {
  id: number
  filename: string
  key: string
  url: string
}

interface MetaRecord {
  id: number
  title: string
  file_id: number
}

export function useUploadService() {
  const uploading: Ref<boolean> = ref(false)
  const uploadError: Ref<string | null> = ref(null)

  async function uploadToCOS(
    taskId: string,
    prompt: string | null,
    onProgress: (percent: number) => void
  ): Promise<{ fileId: number; metaId: number }> {
    uploading.value = true
    uploadError.value = null

    try {
      // Step 1: Get Tripo3D GLB proxy URL
      const downloadRes = await getDownloadUrl(taskId)
      const glbUrl = downloadRes.data.url

      // Step 2: Fetch GLB file to memory
      const arrayBuffer = await fetch(glbUrl).then((r) => r.arrayBuffer())

      // Step 3: Get bucket/region from main backend
      const cloudRes = await mainApi.get<CloudConfig>('/tencent-clouds/cloud')
      const { bucket, region } = cloudRes.data

      // Step 4: Get COS STS credentials
      const tokenRes = await mainApi.get<StsToken>('/tencent-clouds/token')
      const { credentials, expiredTime } = tokenRes.data

      // Step 5: Upload to COS using STS credentials
      const cos = new COS({
        getAuthorization: (_options: unknown, callback: (params: object) => void) => {
          callback({
            TmpSecretId: credentials.tmpSecretId,
            TmpSecretKey: credentials.tmpSecretKey,
            SecurityToken: credentials.sessionToken,
            ExpiredTime: expiredTime
          })
        }
      })

      const cosKey = `ai-3d-models/${taskId}.glb`

      let cosUrl = ''
      try {
        const uploadResult = await new Promise<{ Location?: string }>(
          (resolve, reject) => {
            cos.uploadFile(
              {
                Bucket: bucket,
                Region: region,
                Key: cosKey,
                Body: new Blob([arrayBuffer]),
                onProgress: (info: { percent: number }) => {
                  onProgress(Math.round(info.percent * 100))
                }
              },
              (err: Error | null, data: { Location?: string }) => {
                if (err) {
                  reject(err)
                } else {
                  resolve(data)
                }
              }
            )
          }
        )
        cosUrl = uploadResult.Location ? `https://${uploadResult.Location}` : ''
      } catch (cosErr) {
        const errMsg = cosErr instanceof Error ? cosErr.message : 'COS 上传失败'
        uploadError.value = errMsg
        throw cosErr
      }

      // Step 6: Create file record in main backend
      const fileRes = await mainApi.post<FileRecord>('/files', {
        filename: `${taskId}.glb`,
        md5: '',
        key: cosKey,
        url: cosUrl
      })
      const fileId = fileRes.data.id

      // Step 7: Create Meta asset record
      const title = (prompt || taskId).slice(0, 50)
      const metaRes = await mainApi.post<MetaRecord>('/meta', {
        title,
        file_id: fileId
      })
      const metaId = metaRes.data.id

      // Step 8: Update task meta_id
      await updateTaskMeta(taskId, metaId)

      return { fileId, metaId }
    } catch (err) {
      if (!uploadError.value) {
        uploadError.value = err instanceof Error ? err.message : '上传失败'
      }
      throw err
    } finally {
      uploading.value = false
    }
  }

  return { uploadToCOS, uploading, uploadError }
}
