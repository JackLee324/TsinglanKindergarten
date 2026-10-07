/**
 * server/files/file-view.ts —— 文件行 → 接口返回形状（**只有一份**）
 * ============================================================================
 * 阶段 6 的教训：这个映射一开始被写了两遍 —— `FilesService.toFileView()` 与
 * `ResourcesService.getById()` 里各有一份 `files.map(...)`。
 * 两份的定义很快就分叉了：`getById` 那一份没有 `viewer` / `sizeLabel` /
 * `previewMessage`，于是**资源详情页的文件区**里"此文件类型暂不支持在线预览"
 * 那句话是空的（`docx` 那一条浏览器用例直接把这个问题抓了出来），
 * 而文件列表接口里却是有那句话的 —— 同一个文件在两个接口里长得不一样。
 *
 * 所以映射收在这里：接口返回的文件形状只有一个定义，
 * 谁要返回文件（列表接口、资源详情、以后的导出）都调它。
 */
import {
  PREVIEW_UNSUPPORTED_MESSAGE,
  formatFileSize,
  isPreviewable,
  viewerFor,
} from '../../shared/file-policy'

export interface FileRowLike {
  readonly id: string
  readonly file_name: string
  readonly mime_type: string
  readonly size: string | number
  readonly sha256: string
  readonly created_at: Date | string
}

export interface FileView {
  readonly id: string
  readonly fileName: string
  readonly mimeType: string
  readonly size: number
  /** 服务端格式化好的大小（界面不自己算，免得出现两种写法）。 */
  readonly sizeLabel: string
  readonly sha256: string
  readonly previewable: boolean
  readonly viewer: 'pdf' | 'image' | 'text' | null
  /** 不能预览时界面**逐字**显示这句话；能预览时是 null。 */
  readonly previewMessage: string | null
  readonly createdAt: string
}

export function toFileView(row: FileRowLike): FileView {
  const size = Number(row.size)
  const previewable = isPreviewable(row.file_name, row.mime_type)
  return {
    id: row.id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    size,
    sizeLabel: formatFileSize(size),
    sha256: row.sha256,
    previewable,
    viewer: viewerFor(row.file_name, row.mime_type),
    previewMessage: previewable ? null : PREVIEW_UNSUPPORTED_MESSAGE,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }
}
