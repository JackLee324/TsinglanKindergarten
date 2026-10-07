import { useCallback, useRef, useState } from 'react'
import { ApiError } from '../../api/http'
import {
  UploadCancelledError,
  filesApi,
  putBytes,
  readHeadBytes,
  sha256Hex,
  type UploadProgress,
} from '../../api/files'
import { classifyFile } from '@shared/file-policy'
import { humanMessage } from './errors'

export type UploadPhase = 'idle' | 'hashing' | 'requesting' | 'uploading' | 'registering' | 'done'

export interface FileUploadState {
  readonly phase: UploadPhase
  readonly progress: UploadProgress | null
  readonly error: string | null
  readonly uploadedName: string | null
  readonly busy: boolean
}

/**
 * 把一个文件上传进**已存在的资源**（§4 的四步链路）。
 *
 * 为什么做成 hook：这条链路有两个入口 —— 「上传资源」（新建资源 + 传文件）与
 * 详情页的「+ 添加文件」。把四步写两遍就等于给"取消之后还会不会登记"
 * 这类问题留两个答案。界面只管摆按钮，链路只有这一份。
 *
 * 四步与它们的失败语义：
 *   ① 算 sha256           → 非安全上下文时给出可照做的提示
 *   ② 申请上传地址        → 类型 / 大小 / 权限 / 资源状态由服务端判定
 *   ③ PUT 字节（可取消）  → 存储层按签名里的 sha256 与大小校验字节
 *   ④ 登记                → 服务端确认对象真的在、内容类型对得上
 */
export function useFileUpload(resourceId: string | null) {
  const [state, setState] = useState<FileUploadState>({
    phase: 'idle',
    progress: null,
    error: null,
    uploadedName: null,
    busy: false,
  })
  /** 取消用：XHR 的 abort 回调（每次上传重新收集）。 */
  const abortHandlers = useRef<(() => void)[]>([])

  const reset = useCallback(() => {
    abortHandlers.current = []
    setState({ phase: 'idle', progress: null, error: null, uploadedName: null, busy: false })
  }, [])

  const cancel = useCallback(() => {
    for (const fn of abortHandlers.current) fn()
  }, [])

  /**
   * 上传一个文件。成功后 resolve true。
   *
   * @param overrideResourceId
   *   新建资源的场景：资源 id 是**刚刚**创建出来的，而 hook 的参数来自上一次渲染。
   *   与其让调用方去凑时序，不如把 id 显式传进来 —— 传进来的优先。
   */
  const start = useCallback(
    async (file: File, overrideResourceId?: string): Promise<boolean> => {
      const targetId = overrideResourceId ?? resourceId
      if (targetId === null) {
        setState((s) => ({ ...s, error: '资源还没有创建好，请稍后重试。', busy: false }))
        return false
      }
      abortHandlers.current = []
      setState({ phase: 'hashing', progress: null, error: null, uploadedName: null, busy: true })

      try {
        // ── 上传前先按**同一份策略**校验（magic bytes 也要看）────────────────
        // 这样"选错文件"在本地就能说清楚，不用等一次网络往返。
        const verdict = classifyFile({
          fileName: file.name,
          mimeType: file.type,
          size: file.size,
          headBytes: await readHeadBytes(file),
        })
        if (!verdict.ok) {
          setState({ phase: 'idle', progress: null, error: verdict.message, uploadedName: null, busy: false })
          return false
        }

        const sha256 = await sha256Hex(file)

        // ── ① 申请上传地址（大小与 sha256 会进签名）─────────────────────────
        setState((s) => ({ ...s, phase: 'requesting' }))
        const ticket = await filesApi.uploadUrl(targetId, {
          fileName: file.name,
          mimeType: file.type === '' ? verdict.type.mime : file.type,
          size: file.size,
          sha256,
        })

        // ── ② PUT（真进度、可取消）──────────────────────────────────────────
        setState((s) => ({
          ...s,
          phase: 'uploading',
          progress: { loaded: 0, total: file.size, percent: 0 },
        }))
        const res = await putBytes(ticket.uploadUrl, file, ticket.headers, {
          onProgress: (progress) => setState((s) => ({ ...s, progress })),
          signal: { aborted: false, onAbort: (fn) => abortHandlers.current.push(fn) },
        })
        if (res.status < 200 || res.status >= 300) {
          throw new ApiError(res.status, 'UPLOAD_REJECTED', describeStorageRejection(res.body, res.status))
        }
        setState((s) => ({ ...s, progress: { loaded: file.size, total: file.size, percent: 100 } }))

        // ── ③ 登记：服务端再确认对象在、大小与内容类型都对 ──────────────────
        setState((s) => ({ ...s, phase: 'registering' }))
        await filesApi.register(targetId, ticket.uploadId)

        setState({
          phase: 'done',
          progress: { loaded: file.size, total: file.size, percent: 100 },
          error: null,
          uploadedName: file.name,
          busy: false,
        })
        return true
      } catch (e) {
        if (e instanceof UploadCancelledError) {
          // 取消**不是**失败，而且必须说清"什么都没保存"：
          // 取消之后不会调用 register，所以不会登记一个不完整的文件（§15）。
          setState({
            phase: 'idle',
            progress: null,
            error: '上传已取消，这个文件没有被保存。可以重新选择文件再试。',
            uploadedName: null,
            busy: false,
          })
          return false
        }
        setState({
          phase: 'idle',
          progress: null,
          error: humanMessage(e, '上传失败'),
          uploadedName: null,
          busy: false,
        })
        return false
      }
    },
    [resourceId],
  )

  return { state, start, cancel, reset }
}

/** 把对象存储返回的错误体（XML）翻译成人话。 */
export function describeStorageRejection(body: string, status: number): string {
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? ''
  if (code === 'BadDigest' || /checksum|sha256/i.test(body)) {
    return '文件内容在上传过程中发生了变化（校验值不一致），请重新上传。'
  }
  if (/Content-Md5|checksum/i.test(body)) {
    return '文件内容与校验值不符，上传已被存储服务拒绝。请重新上传。'
  }
  if (status === 403) return '上传地址已过期或无效，请重新申请上传。'
  if (status === 413) return '文件超过大小上限。'
  return `上传被存储服务拒绝（HTTP ${status}），请稍后重试。`
}
