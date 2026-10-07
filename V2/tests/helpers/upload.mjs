/**
 * tests/helpers/upload.mjs —— 走**真实**上传链路的测试夹具
 * ============================================================================
 * 阶段 6 之后，上传不再是"直接把元数据 POST 过去"，而是：
 *   申请地址（带 sha256）→ PUT 字节 → 用票据登记
 *
 * 很多套件（状态机、审核、审计）只需要"这个资源有一个文件"这个前提，
 * 并不关心上传本身。它们的夹具统一走这里 —— 于是：
 *   · 夹具用的是**被测的同一条链路**，没有绕过校验的后门写法；
 *   · 契约再变时只需要改这一个文件。
 */
import { createHash } from 'node:crypto'
import { TEST_BASE } from './harness.mjs'

/** 各类型的默认字节（magic 必须与扩展名相符，否则登记会被拒）。 */
export function pdfBytes(tag = 'fixture') {
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n'),
    Buffer.from(`1 0 obj<</Type/Catalog>>endobj % ${tag}\n`.repeat(8)),
    Buffer.from('%%EOF\n'),
  ])
}

export function textBytes(tag = 'fixture') {
  return Buffer.from(`内容：${tag}\n`, 'utf8')
}

export function docxBytes(tag = 'fixture') {
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
    Buffer.from(`docx ${tag}\n`.repeat(4)),
  ])
}

export const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex')

/**
 * 往一个已存在的资源里上传一个文件，返回登记出来的文件视图。
 *
 * @param as 已登录的测试客户端
 */
export async function uploadFile(as, resourceId, options = {}) {
  const {
    bytes = textBytes(),
    fileName = '教案.txt',
    mimeType = 'text/plain',
  } = options

  const ticket = await as.post(`/api/resources/${resourceId}/files/upload-url`, {
    fileName,
    mimeType,
    size: bytes.byteLength,
    sha256: sha256Hex(bytes),
  })
  if (ticket.status !== 201) {
    throw new Error(`申请上传地址失败（${ticket.status}）：${JSON.stringify(ticket.data)}`)
  }

  const put = await fetch(
    ticket.data.uploadUrl.startsWith('http') ? ticket.data.uploadUrl : `${TEST_BASE}${ticket.data.uploadUrl}`,
    { method: 'PUT', headers: ticket.data.headers, body: bytes },
  )
  if (put.status !== 200) {
    throw new Error(`PUT 失败（${put.status}）：${await put.text()}`)
  }

  const registered = await as.post(`/api/resources/${resourceId}/files/register`, {
    uploadId: ticket.data.uploadId,
  })
  if (registered.status !== 201) {
    throw new Error(`登记失败（${registered.status}）：${JSON.stringify(registered.data)}`)
  }
  return registered.data
}
