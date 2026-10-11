/**
 * tests/unit/ai-pdf.test.mjs —— PDF 文字层提取（宁可少，也不要乱码）
 * ============================================================================
 * 为什么 PDF 要单独写一个解析器、又为什么要测这么细：
 *   · 业主 §五 要求"已上传的文档能被检索"，而幼儿园的现实里 PDF 占比很高
 *     （教案、通知、教研材料多半是 Word/PPT 导出的 PDF）；
 *   · 但 PDF 没有"一段文字"这种概念 —— 只有"在某个位置画某个字形"，
 *     要经过 对象 → 解压流 → 字体 ToUnicode → 内容流算子 四步才能拿到文字；
 *   · 最危险的失败不是"读不出来"，而是**读出一堆乱码**：索引一旦被灌进乱码，
 *     AI 就会拿着乱码硬答（业主 §九 明确禁止"编造"）。
 *
 * 所以这份测试的判据分两类：
 *   ① 能读的必须读对（ASCII 单字节字体 / 中文两字节字体 + ToUnicode / 压缩流 / 对象流）；
 *   ② 读不了必须**如实说不**（加密、扫描件、无 ToUnicode 的两字节字体、非 PDF），
 *      而且**一个字符都不许瞎猜**。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { aiPdf } from '../helpers/modules.mjs'

const { extractPdfText } = aiPdf
const LIMITS = { maxChars: 10_000 }

/**
 * 拼一个 PDF。解析器按 `N 0 obj` 扫描（不读 xref），所以夹具不需要 xref 表 ——
 * 这一点也说明提取器对**增量更新过的 PDF**是友好的：同名对象后出现的会覆盖先出现的。
 */
function pdf(objects) {
  const parts = [Buffer.from('%PDF-1.7\n')]
  for (const object of objects) {
    if (object.stream === undefined) {
      parts.push(Buffer.from(`${object.num} 0 obj\n${object.body}\nendobj\n`))
      continue
    }
    const dict = `${object.body.replace(/>>\s*$/, '')}${object.extraDict ?? ''}/Length ${object.stream.length}>>`
    parts.push(
      Buffer.concat([
        Buffer.from(`${object.num} 0 obj\n${dict}\nstream\n`),
        object.stream,
        Buffer.from('\nendstream\nendobj\n'),
      ]),
    )
  }
  parts.push(Buffer.from('%%EOF\n'))
  return Buffer.concat(parts)
}

/** 单字节字体（Helvetica + WinAnsi）+ 压缩内容流：英文 PDF 的常规形态。 */
function englishPdf() {
  const content = 'BT /F1 24 Tf 72 700 Td (Weekly lesson plan: colors and shapes) Tj ET'
  return pdf(
    [
      { num: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { num: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { num: 3, body: '<</Type/Page/Parent 2 0 R/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>' },
      {
        num: 4,
        body: '<</Filter/FlateDecode>>',
        stream: deflateSync(Buffer.from(content, 'latin1')),
      },
      { num: 5, body: '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>' },
    ],
  )
}

/**
 * Type0（Identity-H）+ ToUnicode CMap：中文 PDF 的常规形态。
 * CMap 同时用两种写法：`bfrange`（含数组形式）与 `bfchar` —— 两条分支都要能解。
 */
function chinesePdf() {
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    'beginbfrange',
    // 数组形式：码位 1..4 → 周 计 划 ：
    '<0001> <0004> [<5468> <8ba1> <5212> <ff1a>]',
    'endbfrange',
    'beginbfchar',
    '<0005> <989c>', // 颜
    '<0006> <8272>', // 色
    '<0007> <4e0e>', // 与
    '<0008> <5f62>', // 形
    '<0009> <72b6>', // 状
    '<000c> <9002>', // 适
    '<000d> <5408>', // 合
    '<000e> <5e7c>', // 幼
    '<000f> <513f>', // 儿
    '<0010> <56ed>', // 园
    '<0011> <7684>', // 的
    'endbfchar',
    'end',
  ].join('\n')
  const line1 = '<000100020003000400050006000700080009>' // 周计划：颜色与形状
  const line2 = '<000c000d000e000f001000110001000200030004>' // 适合幼儿园的周计划：
  const content = `BT /F1 20 Tf 72 700 Td ${line1} Tj 0 -30 Td ${line2} Tj ET`
  return pdf([
    { num: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
    { num: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
    { num: 3, body: '<</Type/Page/Parent 2 0 R/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>' },
    { num: 4, body: '<</Filter/FlateDecode>>', stream: deflateSync(Buffer.from(content, 'latin1')) },
    { num: 5, body: '<</Type/Font/Subtype/Type0/BaseFont/NotoSansSC/Encoding/Identity-H/DescendantFonts[6 0 R]/ToUnicode 7 0 R>>' },
    { num: 6, body: '<</Type/Font/Subtype/CIDFontType2/BaseFont/NotoSansSC>>' },
    { num: 7, body: '<</Length ' + cmap.length + '>>', stream: Buffer.from(cmap, 'latin1') },
  ])
}

/** 两字节字体但**没有** ToUnicode：必须一个字符都不输出（不许按 latin1 硬翻成乱码）。 */
function cidWithoutToUnicodePdf() {
  const content = 'BT /F1 20 Tf 72 700 Td <4f60597d4e2d6587> Tj ET'
  return pdf([
    { num: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
    { num: 3, body: '<</Type/Page/Parent 2 0 R/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>' },
    { num: 4, body: '<</Filter/FlateDecode>>', stream: deflateSync(Buffer.from(content, 'latin1')) },
    { num: 5, body: '<</Type/Font/Subtype/Type0/BaseFont/SomeCJK/Encoding/Identity-H/DescendantFonts[6 0 R]>>' },
    { num: 6, body: '<</Type/Font/Subtype/CIDFontType2/BaseFont/SomeCJK>>' },
  ])
}

/** 对象流（`/Type /ObjStm`）：字体与资源字典被 Flate 压缩在一个流里 —— 现代 PDF 的常态。 */
function objectStreamPdf() {
  // 对象流内部：对象 5（字体）与对象 6（资源），正文顺序存放
  const bodies = [
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<</Font<</F1 5 0 R>>>>',
  ]
  let offset = 0
  const header = []
  const chunks = []
  for (const [i, body] of bodies.entries()) {
    header.push(`${5 + i} ${offset}`)
    const buf = Buffer.from(`${body} `, 'latin1')
    chunks.push(buf)
    offset += buf.length
  }
  const headerText = `${header.join(' ')} `
  const objStm = Buffer.concat([Buffer.from(headerText, 'latin1'), ...chunks])
  const content = 'BT /F1 18 Tf 60 640 Td (Theme: seasons and weather) Tj ET'
  return pdf([
    { num: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
    { num: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
    // 页面的 Resources 指向对象流里的 6 号对象
    { num: 3, body: '<</Type/Page/Parent 2 0 R/Resources 6 0 R/Contents 4 0 R>>' },
    { num: 4, body: '<</Filter/FlateDecode>>', stream: deflateSync(Buffer.from(content, 'latin1')) },
    {
      num: 9,
      body: '<</Type/ObjStm/N 2/First ' + headerText.length + '>>',
      stream: objStm,
    },
  ])
}

describe('① 能读的必须读对', () => {
  test('单字节字体 + FlateDecode 压缩内容流：读出英文正文', () => {
    const result = extractPdfText(englishPdf(), LIMITS)
    assert.equal(result.ok, true, `应当成功：${result.reason ?? ''}`)
    assert.match(result.text, /Weekly lesson plan: colors and shapes/)
  })

  test('**中文**：Type0 + ToUnicode CMap 正确映射成可读汉字', () => {
    const result = extractPdfText(chinesePdf(), LIMITS)
    assert.equal(result.ok, true, `应当成功：${result.reason ?? ''}`)
    assert.match(result.text, /周计划：颜色与形状/, `中文必须映射正确（不是乱码）：${result.text}`)
    assert.match(result.text, /适合幼儿园的周计划/, '第二行也要读出来')
    assert.equal(result.fonts.mapped >= 1, true, '应当识别到 1 个带 ToUnicode 的字体')
  })

  test('换行算子会变成换行（否则两行会粘成一行，检索时句子边界全丢）', () => {
    const result = extractPdfText(chinesePdf(), LIMITS)
    assert.match(
      result.text,
      /周计划：颜色与形状\n适合幼儿园的周计划/,
      `两行之间应当有换行：${JSON.stringify(result.text)}`,
    )
  })

  test('对象流（/ObjStm）里的字体与资源字典也能取到', () => {
    const result = extractPdfText(objectStreamPdf(), LIMITS)
    assert.equal(result.ok, true, `对象流里的字体应当被找到：${result.reason ?? ''}`)
    assert.match(result.text, /Theme: seasons and weather/)
  })

  test('超长正文按上限截断（不把 token 预算打爆）', () => {
    const content = `BT /F1 12 Tf 40 700 Td (${'lesson '.repeat(500)}) Tj ET`
    const long = pdf([
      { num: 3, body: '<</Type/Page/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>' },
      { num: 4, body: '<</Filter/FlateDecode>>', stream: deflateSync(Buffer.from(content, 'latin1')) },
      { num: 5, body: '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>' },
    ])
    const result = extractPdfText(long, { maxChars: 100 })
    assert.equal(result.ok, true)
    assert.equal(result.text.length <= 100, true, `截断到上限：${result.text.length}`)
  })
})

describe('② 读不了必须如实说不（绝对不许瞎猜）', () => {
  test('两字节字体没有 ToUnicode → **一个字符都不输出**（不按 latin1 硬翻）', () => {
    const result = extractPdfText(cidWithoutToUnicodePdf(), LIMITS)
    assert.equal(result.ok, false, '没有 ToUnicode 就不该声称读到了文字')
    assert.equal(result.text, '', '绝不能输出乱码')
    assert.match(String(result.reason), /文字|扫描/, `原因要说人话：${result.reason}`)
  })

  test('扫描件（没有文字层）→ 如实记 EMPTY_TEXT，不灌噪声进索引', () => {
    const scanned = pdf([
      { num: 3, body: '<</Type/Page/Resources<<>>/Contents 4 0 R>>' },
      { num: 4, body: '<</Filter/FlateDecode>>', stream: deflateSync(Buffer.from('q 612 0 0 792 0 0 cm /Im0 Do Q', 'latin1')) },
    ])
    const result = extractPdfText(scanned, LIMITS)
    assert.equal(result.ok, false)
    assert.match(String(result.reason), /扫描|文字层/)
  })

  test('加密 PDF：不去猜密码，也不假装读到了', () => {
    const encrypted = Buffer.concat([
      englishPdf(),
      Buffer.from('\ntrailer<</Encrypt 99 0 R>>\n%%EOF\n'),
    ])
    const result = extractPdfText(encrypted, LIMITS)
    assert.equal(result.ok, false)
    assert.match(String(result.reason), /加密/)
  })

  test('不是 PDF 的字节：明确拒绝（不能靠扩展名猜）', () => {
    const result = extractPdfText(Buffer.from('PK\u0003\u0004 definitely not a pdf'), LIMITS)
    assert.equal(result.ok, false)
    assert.match(String(result.reason), /不是 PDF/)
  })
})

describe('③ 安全性：坏文件不能把索引任务拖垮', () => {
  test('截断/损坏的 PDF 不抛异常，只返回"读不到"', () => {
    const truncated = englishPdf().subarray(0, 120)
    const result = extractPdfText(truncated, LIMITS)
    assert.equal(typeof result.ok, 'boolean', '必须返回结果对象，不能抛')
    assert.equal(result.ok, false)
  })

  test('坏掉的 FlateDecode 流不会让整个提取崩掉', () => {
    const broken = pdf([
      { num: 3, body: '<</Type/Page/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>' },
      { num: 4, body: '<</Filter/FlateDecode>>', stream: Buffer.from('not-deflate-at-all-just-bytes') },
      { num: 5, body: '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>' },
    ])
    const result = extractPdfText(broken, LIMITS)
    assert.equal(result.ok, false, '解压失败就是读不到，不猜')
  })
})
