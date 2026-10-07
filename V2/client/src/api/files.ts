/**
 * client/src/api/files.ts —— 文件接口（上传四步 / 预览 / 下载 / 删除）
 * ============================================================================
 * 这里**不**直接用 `http.ts` 的 PUT 去传文件：浏览器上传要显示进度、要能取消，
 * 而 `fetch` 没有上传进度事件。所以字节那一步用 XMLHttpRequest，
 * 其余（申请地址、登记、列表、下载、删除）都走统一的 `api` 出口。
 *
 * 三个阶段在这里分得很清楚，因为它们失败时用户该看到的提示完全不同：
 *   ① 申请地址  → 类型 / 大小 / 权限 不通过（服务端说了算）
 *   ② PUT 字节  → 网络、取消、存储写入失败（浏览器说得出进度）
 *   ③ 登记      → 服务端确认对象真的存在、大小与哈希都对得上
 */
import { api } from './http'
import type {
  FilePolicySummary,
  ResourceFileSummary,
  PreviewResponse,
  DownloadResponse,
  UploadTicket,
} from './types'

export const filesApi = {
  /** 服务端当前生效的文件策略（与前端 `shared/file-policy.ts` 是同一份）。 */
  policy: (resourceId: string) =>
    api.get<FilePolicySummary>(`/api/resources/${resourceId}/files/policy`),

  list: (resourceId: string) =>
    api.get<{ items: readonly ResourceFileSummary[] }>(`/api/resources/${resourceId}/files`),

  /** ① 申请上传地址。size 与 sha256 会被写进签名，客户端之后改不了。 */
  uploadUrl: (
    resourceId: string,
    input: { fileName: string; mimeType: string; size: number; sha256: string },
  ) => api.post<UploadTicket>(`/api/resources/${resourceId}/files/upload-url`, input),

  /** ③+④ 登记（只传票据 id，其余一律以票据为准）。 */
  register: (resourceId: string, uploadId: string) =>
    api.post<ResourceFileSummary>(`/api/resources/${resourceId}/files/register`, { uploadId }),

  preview: (resourceId: string, fileId: string) =>
    api.get<PreviewResponse>(`/api/resources/${resourceId}/files/${fileId}/preview`),

  download: (resourceId: string, fileId: string) =>
    api.get<DownloadResponse>(`/api/resources/${resourceId}/files/${fileId}/download`),

  remove: (resourceId: string, fileId: string) =>
    api.del<{ ok: boolean }>(`/api/resources/${resourceId}/files/${fileId}`),
}

export interface UploadProgress {
  readonly loaded: number
  readonly total: number
  /** 0–100。总大小未知时返回 0（界面显示"正在上传…"而不是假的百分比）。 */
  readonly percent: number
}

export interface PutHandlers {
  readonly onProgress?: (progress: UploadProgress) => void
  readonly signal?: { readonly aborted: boolean; onAbort: (fn: () => void) => void }
}

/** 上传被用户取消。单独一个类型，界面据此显示"已取消"而不是"失败"。 */
export class UploadCancelledError extends Error {
  constructor() {
    super('上传已取消')
    this.name = 'UploadCancelledError'
  }
}

/**
 * ② 把字节 PUT 到签名地址。
 *
 * 用 XHR 而不是 fetch：只有 XHR 有 `upload.onprogress`（业主 §14 要求显示进度），
 * 也只有 XHR 能干净地 `abort()`（业主 §15 要求可取消）。
 * 取消之后**不会**调用 register，所以不会登记一个不存在/不完整的文件。
 */
export function putBytes(
  url: string,
  file: Blob,
  headers: Record<string, string>,
  handlers: PutHandlers = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }

    handlers.signal?.onAbort(() => {
      xhr.abort()
    })

    xhr.open('PUT', url, true)
    for (const [key, value] of Object.entries(headers)) {
      // 一次性设置所有签名头：少一个或值不同，服务端都会拒绝。
      xhr.setRequestHeader(key, value)
    }
    xhr.upload.onprogress = (event) => {
      if (!handlers.onProgress) return
      const total = event.lengthComputable ? event.total : 0
      handlers.onProgress({
        loaded: event.loaded,
        total,
        percent: total > 0 ? Math.min(100, Math.round((event.loaded / total) * 100)) : 0,
      })
    }
    xhr.onload = () => finish(() => resolve({ status: xhr.status, body: xhr.responseText }))
    xhr.onerror = () =>
      finish(() => reject(new Error('网络中断，上传没有完成。请检查网络后重试。')))
    xhr.ontimeout = () => finish(() => reject(new Error('上传超时。请检查网络后重试。')))
    xhr.onabort = () => finish(() => reject(new UploadCancelledError()))
    xhr.send(file)
  })
}

/**
 * 算 sha256（hex）。
 *
 * ⚠️ `crypto.subtle` 只在**安全上下文**（https 或 localhost）里存在。
 * 部署在纯 http 的非本机域名下时它是 undefined —— 这时必须给一句能照做的提示，
 * 而不是让上传莫名其妙地卡住。
 */
export async function sha256Hex(file: Blob): Promise<string> {
  if (typeof crypto === 'undefined' || crypto.subtle === undefined) {
    throw new Error(
      '当前页面不是安全上下文（需要 https 或 localhost），无法计算文件校验值。请联系管理员。',
    )
  }
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 读文件开头若干字节，用于在**上传之前**就按 magic bytes 拦掉明显不对的文件。 */
export async function readHeadBytes(file: Blob, count = 64): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, count).arrayBuffer())
}
