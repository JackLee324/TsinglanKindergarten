/**
 * tests/unit/ai-extract.test.mjs —— 提取层：不支持的格式必须**说出来**
 * ============================================================================
 * 业主 Stage 15 §五："如果某种格式当前无法可靠解析，要记录为不支持或待处理，
 * 不得假装索引成功。" 这份测试把每种"失败形态"都钉住，
 * 并且验证 Office 家族（zip + 固定 XML 成员）确实能取出文字。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { zipSync, strToU8 } from 'fflate'
import { aiExtract } from '../helpers/modules.mjs'

const { extractFileText, sniffImageMime, extractOfficeText, xmlToText } = aiExtract

const LIMITS = { maxChars: 10_000, maxBytes: 5_000_000 }
const base = (over = {}) => ({ bytes: Buffer.from(''), fileName: 'x.txt', mimeType: 'text/plain', limits: LIMITS, ...over })

describe('① 图片格式按内容判断（不信扩展名）', () => {
  test('JPEG / PNG / GIF / WebP 的魔数都能认出来', () => {
    assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg')
    assert.equal(sniffImageMime(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(8)])), 'image/png')
    assert.equal(sniffImageMime(Buffer.from('GIF89a______', 'latin1')), 'image/gif')
    assert.equal(sniffImageMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])), 'image/webp')
  })

  test('普通文本不会被误判成图片', () => {
    assert.equal(sniffImageMime(Buffer.from('这是一段中文文本，不是图片。')), null)
  })
})

describe('② 图片：OCR 未启用 → 如实记录，不是"索引成功但没内容"', () => {
  test('没有 ocr 回调 → OCR_DISABLED，并说明只索引了元数据', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20)])
    const outcome = await extractFileText(base({ bytes: png, fileName: '教学照片.png', mimeType: 'image/png' }))
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'OCR_DISABLED')
    assert.match(outcome.reason, /OCR/)
  })

  test('有 ocr 回调 → FILE_OCR，并把用量带回来（成本可记账）', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20)])
    const outcome = await extractFileText(
      base({
        bytes: png,
        fileName: '教学照片.png',
        mimeType: 'image/png',
        ocr: async () => ({ text: '本周主题：秋天\n讨论落叶的颜色', usage: { inputTokens: 800, outputTokens: 30 } }),
      }),
    )
    assert.equal(outcome.ok, true)
    assert.equal(outcome.kind, 'FILE_OCR')
    assert.match(outcome.text, /秋天/)
    assert.deepEqual(outcome.usage, { inputTokens: 800, outputTokens: 30 })
  })

  test('OCR 空结果 → EMPTY_TEXT（不是成功）', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20)])
    const outcome = await extractFileText(base({ bytes: png, mimeType: 'image/png', ocr: async () => ({ text: '   ' }) }))
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'EMPTY_TEXT')
  })

  test('OCR 抛错 → OCR_FAILED，原因带回去（不吞）', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20)])
    const outcome = await extractFileText(
      base({ bytes: png, mimeType: 'image/png', ocr: async () => { throw new Error('限流 429') } }),
    )
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'OCR_FAILED')
    assert.match(outcome.reason, /429/)
  })
})

describe('③ 纯文本类直接解码', () => {
  test('txt / md / csv / json 都能取字，超长会截断到上限', async () => {
    for (const [name, mime] of [['a.txt', 'text/plain'], ['b.md', 'text/markdown'], ['c.csv', 'text/csv'], ['d.json', 'application/json']]) {
      const outcome = await extractFileText(base({ bytes: Buffer.from('内容 content'), fileName: name, mimeType: mime }))
      assert.equal(outcome.ok, true, name)
      assert.equal(outcome.kind, 'FILE_TEXT')
    }
    const long = await extractFileText(
      base({ bytes: Buffer.from('字'.repeat(500)), fileName: 'long.txt', mimeType: 'text/plain', limits: { maxChars: 100, maxBytes: 1e6 } }),
    )
    assert.equal(long.ok, true)
    assert.equal(long.text.length, 100)
  })

  test('空文本文件 → EMPTY_TEXT', async () => {
    const outcome = await extractFileText(base({ bytes: Buffer.from('   \n  '), fileName: 'empty.txt', mimeType: 'text/plain' }))
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'EMPTY_TEXT')
  })
})

describe('④ Office 家族（zip + 固定 XML 成员，不解压其它内容）', () => {
  test('docx：取出带段落换行的正文，实体被还原', async () => {
    const xml = `<?xml version="1.0"?><w:document><w:body>
      <w:p><w:r><w:t>第一段：主题教学</w:t></w:r></w:p>
      <w:p><w:r><w:t>第二段 &amp; 符号 &lt;标签&gt;</w:t></w:r></w:p>
    </w:body></w:document>`
    const zip = zipSync({ 'word/document.xml': strToU8(xml) })
    const outcome = await extractFileText(
      base({ bytes: Buffer.from(zip), fileName: '教案.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
    )
    assert.equal(outcome.ok, true)
    assert.match(outcome.text, /第一段：主题教学/)
    assert.match(outcome.text, /第二段 & 符号 <标签>/)
    assert.equal(outcome.text.split('\n').filter((l) => l.includes('第一段')).length, 1)
  })

  test('pptx：按页顺序取文字并标出页码', async () => {
    const slide = (t) => `<p:sld><a:t>${t}</a:t></p:sld>`
    const zip = zipSync({
      'ppt/slides/slide2.xml': strToU8(slide('第二页内容')),
      'ppt/slides/slide1.xml': strToU8(slide('第一页内容')),
    })
    const outcome = await extractFileText(base({ bytes: Buffer.from(zip), fileName: '课件.pptx', mimeType: 'application/vnd.ms-powerpoint' }))
    assert.equal(outcome.ok, true)
    const firstIndex = outcome.text.indexOf('【第 1 页】')
    const secondIndex = outcome.text.indexOf('【第 2 页】')
    assert.equal(firstIndex >= 0 && secondIndex > firstIndex, true, '页码顺序应当是 1 → 2')
  })

  test('xlsx：共享字符串与工作表都能取到', async () => {
    const zip = zipSync({
      'xl/sharedStrings.xml': strToU8('<sst><si><t>美德</t></si></sst>'),
      'xl/worksheets/sheet1.xml': strToU8('<worksheet><row><c>1</c></row></worksheet>'),
    })
    const outcome = await extractFileText(base({ bytes: Buffer.from(zip), fileName: '清单.xlsx', mimeType: 'application/vnd.ms-excel' }))
    assert.equal(outcome.ok, true)
    assert.match(outcome.text, /美德/)
  })

  test('假的 docx（不是 zip）→ CORRUPT，而不是抛异常', async () => {
    const outcome = await extractFileText(base({ bytes: Buffer.from('这不是 zip'), fileName: '坏文件.docx', mimeType: 'application/msword' }))
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'CORRUPT')
  })

  test('zip 里没有 document.xml → CORRUPT 且说明缺什么', () => {
    const zip = zipSync({ 'other.txt': strToU8('x') })
    const outcome = extractOfficeText(Buffer.from(zip), '空壳.docx')
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'CORRUPT')
    assert.match(outcome.reason, /document\.xml/)
  })
})

describe('⑤ 明确不支持 / 超限：一律记原因', () => {
  /*
    PDF（Stage 15 的 P5 接入）：文字层能读就读出正文；
    读不出（扫描件、无 ToUnicode、加密）必须**如实说原因**，而且原文件照常可预览下载。
    细节算法在 `ai-pdf.test.mjs` 里单独测（CMap/对象流/压缩流），这里只压"接进来了"。
  */
  test('PDF 有文字层 → 提到 FILE_TEXT 正文', async () => {
    const content = 'BT /F1 18 Tf 72 700 Td (Weekly lesson plan: seasons) Tj ET'
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.7\n'),
      Buffer.from('3 0 obj\n<</Type/Page/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>\nendobj\n'),
      Buffer.from(`4 0 obj\n<</Length ${content.length}>>\nstream\n${content}\nendstream\nendobj\n`),
      Buffer.from('5 0 obj\n<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>\nendobj\n'),
      Buffer.from('%%EOF\n'),
    ])
    const outcome = await extractFileText(base({ bytes: pdf, fileName: '教案.pdf', mimeType: 'application/pdf' }))
    assert.equal(outcome.ok, true, `应当读出正文：${outcome.reason ?? ''}`)
    assert.equal(outcome.kind, 'FILE_TEXT')
    assert.match(outcome.text, /Weekly lesson plan: seasons/)
  })

  test('PDF 读不出文字层（扫描件/加密）→ 记 EMPTY_TEXT，原因说清且不影响原文件', async () => {
    const outcome = await extractFileText(base({ bytes: Buffer.from('%PDF-1.7 x'), fileName: 'a.pdf', mimeType: 'application/pdf' }))
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'EMPTY_TEXT')
    assert.match(outcome.reason, /PDF|扫描/)
    assert.match(outcome.reason, /预览与下载/, '要说清"原文件不受影响"')
  })

  test('压缩包不解压（安全策略）', async () => {
    const outcome = await extractFileText(base({ bytes: Buffer.from('PK'), fileName: '打包.zip', mimeType: 'application/zip' }))
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'UNSUPPORTED_FORMAT')
    assert.match(outcome.reason, /压缩包/)
  })

  test('超过字节上限 → TOO_LARGE，不做解析', async () => {
    const outcome = await extractFileText(base({ bytes: Buffer.alloc(2000), fileName: '大.txt', mimeType: 'text/plain', limits: { maxChars: 100, maxBytes: 1000 } }))
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'TOO_LARGE')
  })

  test('未知格式 → UNSUPPORTED_FORMAT', async () => {
    const outcome = await extractFileText(base({ bytes: Buffer.from([0, 1, 2]), fileName: 'a.bin', mimeType: 'application/octet-stream' }))
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'UNSUPPORTED_FORMAT')
  })

  test('xmlToText 会去掉声明与注释、把块级标签变成换行', () => {
    const text = xmlToText('<?xml version="1.0"?><!-- 注释 --><a><p>甲</p><p>乙</p></a>')
    assert.doesNotMatch(text, /注释/)
    assert.match(text, /甲\n乙/)
  })
})
