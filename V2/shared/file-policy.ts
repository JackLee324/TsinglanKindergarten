/**
 * shared/file-policy.ts —— 文件策略（**前后端唯一一份**）
 * ============================================================================
 * 为什么必须放在 shared 而不是各写一份：
 *
 * 业主明确点出过 V1 的一个具体故障：「前端 50MB、后端 100MB，
 * 于是用户上传到一半才失败」。只要上限在两个地方各写一遍，这件事就会再发生一次。
 * 所以大小上限、允许的类型、预览能力、以及**给用户看的每一句话**都在这里，
 * 前端用它做即时校验，后端用它做最终判定，两边读的是同一个常量。
 *
 * 判定策略（业主 §5）：**扩展名 + MIME + magic bytes 三者综合判断**，
 * 不信任何单独一项：
 *   · 只看扩展名 → `evil.pdf` 里其实是一段 HTML 也能过；
 *   · 只看 MIME    → MIME 由客户端随意声明；
 *   · 只看 magic   → 一个 zip 改名成 .pdf 会过（docx/xlsx/pptx 本来就是 zip）。
 */

/** 单个文件上限：50 MB。前端用它做即时提示，后端用它做最终拒绝。 */
export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024

/** 界面上显示的写法（不要在界面里自己算，免得出现"50 MB"和"51200 KB"两种说法）。 */
export const MAX_FILE_SIZE_LABEL = '50 MB'

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 文件类别决定"能不能在线预览"以及用哪个 viewer。 */
export type FileKind = 'pdf' | 'image' | 'text' | 'office' | 'archive'

export interface AllowedFileType {
  /** 规范化扩展名（小写、不含点）。 */
  readonly ext: string
  /** 该扩展名唯一允许的 MIME。 */
  readonly mime: string
  readonly label: string
  readonly kind: FileKind
  /** 是否可以在页面内预览。`office` / `archive` 一律只能下载。 */
  readonly previewable: boolean
}

/**
 * 允许上传的类型（业主 §5 的原话清单）。
 *
 * 注意 `mime` 是**唯一权威**：客户端声明的 MIME 必须与扩展名推导出的这一条一致，
 * 否则拒绝。这样"把 .exe 改名成 .pdf 再声明 text/html"这类组合过不去。
 */
export const ALLOWED_FILE_TYPES: readonly AllowedFileType[] = Object.freeze([
  { ext: 'pdf', mime: 'application/pdf', label: 'PDF', kind: 'pdf', previewable: true },
  { ext: 'png', mime: 'image/png', label: 'PNG 图片', kind: 'image', previewable: true },
  { ext: 'jpg', mime: 'image/jpeg', label: 'JPG 图片', kind: 'image', previewable: true },
  { ext: 'jpeg', mime: 'image/jpeg', label: 'JPEG 图片', kind: 'image', previewable: true },
  { ext: 'txt', mime: 'text/plain', label: '纯文本', kind: 'text', previewable: true },
  {
    ext: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    label: 'Word 文档',
    kind: 'office',
    previewable: false,
  },
  {
    ext: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    label: 'Excel 表格',
    kind: 'office',
    previewable: false,
  },
  {
    ext: 'pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    label: 'PowerPoint 演示文稿',
    kind: 'office',
    previewable: false,
  },
  { ext: 'zip', mime: 'application/zip', label: 'ZIP 压缩包', kind: 'archive', previewable: false },
])

/** 界面上"允许哪些类型"的提示文案。 */
export const ALLOWED_TYPES_LABEL = ALLOWED_FILE_TYPES.map((t) => t.ext.toUpperCase()).join(' / ')

/**
 * 明确禁止的扩展名（业主 §5）。
 *
 * 这不是"白名单之外"的同义词：白名单已经拒绝了它们。
 * 单独列出是因为**双扩展名**要靠它 —— `test.pdf.exe` 的最终扩展名是 exe（白名单已拒），
 * 但 `test.exe.pdf` 的最终扩展名是 pdf，只看最后一段就会放行一个可执行文件的内容，
 * 所以要检查名字里**任何一段**扩展名是否危险。
 */
export const DANGEROUS_EXTENSIONS: readonly string[] = Object.freeze([
  'php', 'php3', 'php4', 'php5', 'phtml',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx',
  'html', 'htm', 'xhtml', 'shtml',
  'exe', 'dll', 'bat', 'cmd', 'com', 'msi', 'scr', 'jar',
  'sh', 'bash', 'zsh', 'ps1', 'py', 'rb', 'pl',
  'jsp', 'asp', 'aspx', 'cgi', 'svg',
])

export const FILE_ERROR_CODES = {
  FILE_TYPE_NOT_ALLOWED: 'FILE_TYPE_NOT_ALLOWED',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  FILE_NAME_UNSAFE: 'FILE_NAME_UNSAFE',
  FILE_HASH_MISMATCH: 'FILE_HASH_MISMATCH',
  FILE_SIZE_MISMATCH: 'FILE_SIZE_MISMATCH',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  STORAGE_NOT_CONFIGURED: 'STORAGE_NOT_CONFIGURED',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
} as const

export type FileErrorCode = (typeof FILE_ERROR_CODES)[keyof typeof FILE_ERROR_CODES]

/** 文件类型不支持预览时，界面必须**逐字**显示这句话（业主指定的原文）。 */
export const PREVIEW_UNSUPPORTED_MESSAGE = '此文件类型暂不支持在线预览，请下载查看。'

/** 允许的扩展名 → 类型定义。 */
export function typeForExtension(fileName: string): AllowedFileType | null {
  const ext = fileExtensionOf(fileName)
  if (ext === '') return null
  return ALLOWED_FILE_TYPES.find((t) => t.ext === ext) ?? null
}

/** 取规范化扩展名（小写、不含点）。没有扩展名返回空串。 */
export function fileExtensionOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

/** 名字里出现的**所有**扩展名段（用于双扩展名检查）。 */
export function extensionSegments(fileName: string): string[] {
  const base = fileName.split(/[\\/]/).pop() ?? ''
  return base
    .split('.')
    .slice(1)
    .map((s) => s.toLowerCase())
    .filter((s) => s.length > 0 && s.length <= 10)
}

/**
 * 文件名是否不安全（路径穿越 / 控制字符 / 双扩展名）。
 *
 * 存储 key 里用的是服务端生成的 safeName，但**原始文件名会被存进数据库并回显给用户**，
 * 也会出现在 Content-Disposition 里 —— 所以它本身也必须干净。
 */
export function unsafeFileNameReason(fileName: unknown): string | null {
  if (typeof fileName !== 'string' || fileName.trim() === '') return '文件名为空'
  if (fileName.length > 255) return '文件名过长（超过 255 个字符）'
  if (fileName !== fileName.trim()) return '文件名首尾不能有空格'
  // 路径穿越：两种分隔符都要挡，Windows 风格的反斜杠同样能穿越。
  if (fileName.includes('/') || fileName.includes('\\')) return '文件名不能包含路径分隔符'
  if (fileName.includes('..')) return '文件名不能包含 ".."'
  // 控制字符 / NUL：会污染 Content-Disposition 与日志。
  // 这里**必须**匹配控制字符：它们会污染 Content-Disposition 与日志。
  // 规则本身没有错，所以忽略这条 lint 而不是绕开检查。
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(fileName)) return '文件名不能包含控制字符'
  if (fileName === '.' || fileName === '..') return '文件名不合法'

  const dangerous = extensionSegments(fileName).find((seg) => DANGEROUS_EXTENSIONS.includes(seg))
  if (dangerous !== undefined) {
    return `文件名里不允许出现 .${dangerous}（可执行 / 脚本 / 网页类扩展名）`
  }
  return null
}

/** magic bytes 探测出的容器类型。 */
export type ContainerKind = 'pdf' | 'png' | 'jpeg' | 'zip' | 'text' | 'unknown'

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] // %PDF-
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_MAGIC = [0xff, 0xd8, 0xff]
const ZIP_MAGIC = [0x50, 0x4b] // PK

function startsWith(buf: Uint8Array, magic: readonly number[]): boolean {
  if (buf.length < magic.length) return false
  return magic.every((b, i) => buf[i] === b)
}

/**
 * 按 magic bytes 判断容器类型。
 *
 * `docx` / `xlsx` / `pptx` / `zip` **都是 zip**，magic 只能到此为止 ——
 * 想再细分就要解析 zip 目录，那是另一件事。所以类型判定靠
 * "扩展名 + MIME + 容器"三者一致，而不是靠 magic 一项。
 */
export function detectContainer(buf: Uint8Array): ContainerKind {
  if (startsWith(buf, PDF_MAGIC)) return 'pdf'
  if (startsWith(buf, PNG_MAGIC)) return 'png'
  if (startsWith(buf, JPEG_MAGIC)) return 'jpeg'
  if (startsWith(buf, ZIP_MAGIC)) return 'zip'
  if (looksLikeText(buf)) return 'text'
  return 'unknown'
}

/**
 * 是不是纯文本。
 *
 * 判据：没有 NUL 字节，且能被 UTF-8 严格解码、不含其它 C0 控制字符（换行/制表除外）。
 * 这样"把一段 HTML 改名成 .txt"仍然可以**当作文本**显示 ——
 * 这是安全的：我们回给浏览器的是 `text/plain` + `nosniff`，脚本不会执行（见 §36）。
 */
export function looksLikeText(buf: Uint8Array): boolean {
  if (buf.length === 0) return true
  for (const byte of buf) {
    if (byte === 0x00) return false
    // 允许 \t \n \r，其余 C0 控制字符视为二进制
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return false
  }

  /*
    ⚠️ 这里必须容忍**末尾被切开的多字节字符**，否则中文文本会被判成二进制。

    为什么：服务端做 magic 判断时只读文件开头的 64 字节（`readRange(key, 64)`，
    为了不把整个文件拉回 VPS）。一个 UTF-8 汉字占 3 字节，64 不是 3 的倍数 ——
    于是"第 64 个字节正好是某个汉字的中间"是**常态**，严格解码必然抛错。

    这个缺陷是阶段 11 的手机端验收抓出来的：一份正常的中文 `.txt`
    报「文件内容与扩展名不符（.txt 的实际内容看起来是未知二进制内容）」。
    之前没暴露，只是因为测试夹具的文本都短于 64 字节。

    容忍的范围很窄：**只**原谅"一个多字节序列开了头、但被读断了"这一种情况，
    而且要求它前面已经有完整内容。中间的非法字节、非法的头字节（如 0xFF）
    依旧算二进制 —— 退字节不等于放水。
  */
  if (decodesAsUtf8(buf)) return true
  return hasTruncatedMultiByteTail(buf)
}

function decodesAsUtf8(buf: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

/** 末尾是不是"一个合法多字节序列被读断"（前面已有完整内容）。 */
function hasTruncatedMultiByteTail(buf: Uint8Array): boolean {
  for (let trim = 1; trim <= 3 && trim < buf.length; trim += 1) {
    const cut = buf.length - trim
    if (cut === 0) return false
    const lead = buf[cut]
    /*
      只有在"切点那个字节声明的序列长度**比被切掉的部分更长**"时，才算读断。
      两头都对得上才是截断：

        `…e4`      ：cut 处 lead=0xe4 声明 3 字节，只切掉 1 个 → 1 < 3，成立；
        `…e4 b8`   ：cut 处 lead=0xe4 声明 3 字节，切掉 2 个 → 2 < 3，成立；
        `…41 e4 ff`：cut 处 lead=0xe4 声明 3 字节、trim=1 < 3 看着成立，
                     但被切掉的那个字节 0xff 不是延续字节 → 判否；
        `e5 41`    ：trim=1 时 cut=1、lead=0x41 不是任何头字节（expected=0，跳过）；
                     trim=2 时 cut=0（前面没有完整内容）→ 判否。

      退字节不等于放水：被切掉的部分只要有非延续字节、或者头字节本身非法
      （如孤立 0xff），后续的"前缀能解码"这一关也过不去（前缀里那个头字节找不到续接）。
    */
    const expected =
      (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 ? 4 : 0
    if (!(trim < expected)) continue
    let continuationOnly = true
    for (let i = cut + 1; i < buf.length; i += 1) {
      if ((buf[i] & 0xc0) !== 0x80) {
        continuationOnly = false
        break
      }
    }
    if (!continuationOnly) continue
    if (decodesAsUtf8(buf.subarray(0, cut))) return true
  }
  return false
}

export interface FileRejection {
  readonly ok: false
  readonly code: FileErrorCode
  readonly message: string
  readonly status: 400 | 413
}

export interface FileAcceptance {
  readonly ok: true
  readonly type: AllowedFileType
}

/**
 * 上传前的完整判定：**扩展名 + MIME + magic bytes**。
 *
 * @param headBytes 文件开头若干字节（≥ 16 字节就够判断所有 magic）。后端用对象前 64 字节，
 *                  前端用 File 的前 64 字节（`slice(0, 64).arrayBuffer()`），两边同一套规则。
 */
export function classifyFile(input: {
  readonly fileName: unknown
  readonly mimeType: unknown
  readonly size: unknown
  readonly headBytes?: Uint8Array
}): FileAcceptance | FileRejection {
  const unsafe = unsafeFileNameReason(input.fileName)
  if (unsafe !== null) {
    return { ok: false, code: FILE_ERROR_CODES.FILE_NAME_UNSAFE, message: unsafe, status: 400 }
  }
  const fileName = input.fileName as string

  const type = typeForExtension(fileName)
  if (type === null) {
    return {
      ok: false,
      code: FILE_ERROR_CODES.FILE_TYPE_NOT_ALLOWED,
      message: `不支持这种文件类型（只允许 ${ALLOWED_TYPES_LABEL}）`,
      status: 400,
    }
  }

  // 大小：`size` 未知（NaN / 负数）也按非法处理，不能因为"读不到"就放行。
  if (typeof input.size !== 'number' || !Number.isFinite(input.size) || input.size <= 0) {
    return {
      ok: false,
      code: FILE_ERROR_CODES.FILE_SIZE_MISMATCH,
      message: '文件大小无效（空文件或无法读取）',
      status: 400,
    }
  }
  if (input.size > MAX_FILE_SIZE_BYTES) {
    return {
      ok: false,
      code: FILE_ERROR_CODES.FILE_TOO_LARGE,
      message: `文件超过 ${MAX_FILE_SIZE_LABEL} 上限`,
      status: 413,
    }
  }

  // MIME 必须与扩展名推导出的那一份一致（客户端声明不作数，但必须**不矛盾**）。
  const declaredMime = normalizeMime(input.mimeType)
  if (declaredMime !== '' && declaredMime !== type.mime) {
    return {
      ok: false,
      code: FILE_ERROR_CODES.FILE_TYPE_NOT_ALLOWED,
      message: `文件类型与扩展名不符（.${type.ext} 应为 ${type.mime}，收到 ${declaredMime}）`,
      status: 400,
    }
  }

  // 容器必须与该类型相符。
  if (input.headBytes !== undefined) {
    const container = detectContainer(input.headBytes)
    const expected: Record<FileKind, ContainerKind[]> = {
      pdf: ['pdf'],
      image: type.ext === 'png' ? ['png'] : ['jpeg'],
      text: ['text'],
      office: ['zip'],
      archive: ['zip'],
    }
    if (!expected[type.kind].includes(container)) {
      return {
        ok: false,
        code: FILE_ERROR_CODES.FILE_TYPE_NOT_ALLOWED,
        message: `文件内容与扩展名不符（.${type.ext} 的实际内容看起来是 ${CONTAINER_LABEL[container]}）`,
        status: 400,
      }
    }
  }

  return { ok: true, type }
}

const CONTAINER_LABEL: Record<ContainerKind, string> = {
  pdf: 'PDF',
  png: 'PNG 图片',
  jpeg: 'JPEG 图片',
  zip: '压缩包',
  text: '纯文本',
  unknown: '未知二进制内容',
}

/** `application/pdf; charset=binary` → `application/pdf`。 */
export function normalizeMime(mimeType: unknown): string {
  if (typeof mimeType !== 'string') return ''
  return mimeType.split(';')[0].trim().toLowerCase()
}

/**
 * 可预览的 MIME 清单。
 *
 * 由 `ALLOWED_FILE_TYPES` **推导**，不再手写第二份 ——
 * 手写的那一份迟早会和类型表对不上（V1 的"第二份真相"就是这么长出来的）。
 */
export const PREVIEWABLE_MIME_TYPES: readonly string[] = Object.freeze([
  ...new Set(ALLOWED_FILE_TYPES.filter((t) => t.previewable).map((t) => t.mime)),
])

/** 只按 MIME 判断（历史数据 / 没有文件名时的兜底）。 */
export function isPreviewableMime(mimeType: unknown): boolean {
  return PREVIEWABLE_MIME_TYPES.includes(normalizeMime(mimeType))
}

/**
 * 能不能在线预览。**以扩展名推导出的类型为准**，MIME 只作兜底 ——
 * 否则有人声明 `image/png` 就能让一个 zip 走图片预览路径。
 */
export function isPreviewable(fileName: string, mimeType?: string): boolean {
  const byName = typeForExtension(fileName)
  if (byName !== null) return byName.previewable
  // 兜底：历史数据（阶段 2 写入的 mime_type）扩展名认不出来时按 MIME 判。
  return isPreviewableMime(mimeType)
}

/** 预览时该用哪个 viewer。 */
export function viewerFor(fileName: string, mimeType?: string): 'pdf' | 'image' | 'text' | null {
  const type = typeForExtension(fileName)
  const kind = type?.kind ?? null
  if (kind === 'pdf') return 'pdf'
  if (kind === 'image') return 'image'
  if (kind === 'text') return 'text'
  const mime = normalizeMime(mimeType)
  if (mime === 'application/pdf') return 'pdf'
  if (mime === 'image/png' || mime === 'image/jpeg') return 'image'
  if (mime === 'text/plain') return 'text'
  return null
}

/**
 * 生成对象存储 key 里的安全文件名段。
 *
 * 保留中文（业主 §7：原始文件名允许中文），只把明显不安全 / 会干扰路径的字符换掉。
 * key 的形状是 `resources/{resourceId}/{uuid}-{safeName}` —— **用户文件名不参与目录结构**，
 * 所以 `../` 之类即使漏过校验也无法穿越（双保险）。
 */
export function safeFileNameSegment(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? 'file'
  const cleaned = base
    // eslint-disable-next-line no-control-regex -- 同上：要删的就是控制字符
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^\w.\-\u4e00-\u9fa5]/g, '_')
    .replace(/^\.+/, '')
  const trimmed = cleaned.slice(0, 80)
  return trimmed === '' ? 'file' : trimmed
}
