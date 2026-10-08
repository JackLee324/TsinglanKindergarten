/**
 * tests/unit/file-policy.test.mjs —— 文件策略（业主 §5 / §6 / §7 / §9）
 * ============================================================================
 * 这一份测的是**上传闸门本身**。它挡不住的每一个漏洞，最终都会变成一个
 * 躺在对象存储里、可以被下载走的可疑文件。
 *
 * 判定要求是「扩展名 + MIME + magic bytes 三者综合」，
 * 所以下面每一类都单独有一组用例，并且**专门测"三者互相矛盾"的情况** ——
 * 只看任何单独一项都能被轻易绕过：
 *   · 只看扩展名 → `教案.pdf` 里其实是 HTML；
 *   · 只看 MIME    → MIME 完全由客户端声明；
 *   · 只看 magic   → docx/xlsx/pptx/zip 都是 zip，彼此分不出来。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { filePolicy } from '../helpers/modules.mjs'

const {
  MAX_FILE_SIZE_BYTES,
  MAX_FILE_SIZE_LABEL,
  ALLOWED_FILE_TYPES,
  ALLOWED_TYPES_LABEL,
  DANGEROUS_EXTENSIONS,
  classifyFile,
  detectContainer,
  fileExtensionOf,
  extensionSegments,
  unsafeFileNameReason,
  safeFileNameSegment,
  viewerFor,
  formatFileSize,
  PREVIEW_UNSUPPORTED_MESSAGE,
} = filePolicy

const ok = (over) => classifyFile({ fileName: 'a.pdf', mimeType: 'application/pdf', size: 100, ...over })

/** 各类文件的开头字节。 */
const BYTES = {
  pdf: () => Buffer.from('%PDF-1.7\n1 0 obj\n', 'utf8'),
  png: () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]),
  jpeg: () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]),
  zip: () => Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
  text: () => Buffer.from('这是纯文本\nsecond line\n', 'utf8'),
  html: () => Buffer.from('<!DOCTYPE html><script>alert(1)</script>', 'utf8'),
  elf: () => Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]),
}

describe('中文文本与"只读 64 字节"的边界（阶段 11 手机验收抓出来的缺陷）', () => {
  const { detectContainer, looksLikeText } = filePolicy

  test('一份正常的中文 .txt，只读开头 64 字节也必须判成文本', () => {
    /*
      服务端为了不把整个文件拉回来，只读开头 64 字节做 magic 判断。
      一个汉字 3 字节，64 不是 3 的倍数 —— 末尾必然可能把某个汉字切开。
      严格解码会因此报错，于是一份完全正常的中文教案被判成"未知二进制内容"。
      这条断言就是那个缺陷的门闩。
    */
    const bytes = Buffer.from('教案正文：' + '一二三四五六七八九十'.repeat(40), 'utf8')
    assert.equal(detectContainer(new Uint8Array(bytes.subarray(0, 64))), 'text')
    assert.equal(detectContainer(new Uint8Array(bytes)), 'text')
  })

  test('每个可能的截断位置都能过（4..64 字节全部试一遍）', () => {
    /*
      从 4 字节起：1~3 字节只够装一个"半个汉字"，那种长度本来就无法判定，
      判成二进制是安全的（真实文件不会是 1 个字节的中文）。
      真正要保证的是：一旦文件中**已经有完整内容**，尾巴被切开不影响判定。
    */
    const bytes = Buffer.from('美德课程教案：' + '观察记录'.repeat(50), 'utf8')
    for (let len = 4; len <= 64; len += 1) {
      assert.equal(
        looksLikeText(new Uint8Array(bytes.subarray(0, len))),
        true,
        `读前 ${len} 字节时被误判成二进制`,
      )
    }
  })

  test('中间的非法字节仍然算二进制（只原谅被截断的尾巴）', () => {
    const broken = Buffer.concat([Buffer.from('abc'), Buffer.from([0xff, 0xfe]), Buffer.from('def')])
    assert.equal(looksLikeText(new Uint8Array(broken)), false)
    assert.equal(detectContainer(new Uint8Array(broken)), 'unknown')
  })

  test('非法头字节 / 中间坏字节不算文本（退字节不是放水）', () => {
    assert.equal(looksLikeText(new Uint8Array(Buffer.from([0xff]))), false, '0xFF 不是合法的 UTF-8 头')
    assert.equal(looksLikeText(new Uint8Array(Buffer.from([0xe5, 0x41]))), false, '头字节后面跟的不是延续字节')
    assert.equal(
      looksLikeText(new Uint8Array(Buffer.concat([Buffer.from('美德'), Buffer.from([0x80, 0x80])]))),
      false,
      '孤立延续字节（前面没有头字节）不是文本',
    )
  })

  test('含 NUL 的仍然是二进制', () => {
    assert.equal(detectContainer(new Uint8Array(Buffer.from([0x41, 0x00, 0x42]))), 'unknown')
  })
})

describe('允许的类型就是业主给的那张清单', () => {
  test('九个扩展名，一个不多一个不少', () => {
    assert.deepEqual(
      ALLOWED_FILE_TYPES.map((t) => t.ext),
      ['pdf', 'png', 'jpg', 'jpeg', 'txt', 'docx', 'xlsx', 'pptx', 'zip'],
    )
    assert.equal(ALLOWED_TYPES_LABEL, 'PDF / PNG / JPG / JPEG / TXT / DOCX / XLSX / PPTX / ZIP')
  })

  test('只有 PDF / 图片 / 纯文本可以预览，Office 与 ZIP 一律只下载', () => {
    const previewable = ALLOWED_FILE_TYPES.filter((t) => t.previewable).map((t) => t.ext)
    assert.deepEqual(previewable, ['pdf', 'png', 'jpg', 'jpeg', 'txt'])
  })

  test('大小上限只有一份，前后端读的是同一个常量', () => {
    assert.equal(MAX_FILE_SIZE_BYTES, 50 * 1024 * 1024)
    assert.equal(MAX_FILE_SIZE_LABEL, '50 MB')
  })
})

describe('扩展名解析', () => {
  test('大小写、路径、多点都要正确处理', () => {
    assert.equal(fileExtensionOf('A.PDF'), 'pdf')
    assert.equal(fileExtensionOf('教案.v2.pdf'), 'pdf')
    assert.equal(fileExtensionOf('/tmp/x/照片.JPG'), 'jpg')
    assert.equal(fileExtensionOf('没有扩展名'), '')
    assert.equal(fileExtensionOf('结尾是点.'), '')
    assert.equal(fileExtensionOf('.hidden'), '')
  })

  test('能列出名字里出现的所有扩展名段（双扩展名检查靠它）', () => {
    assert.deepEqual(extensionSegments('test.pdf.exe'), ['pdf', 'exe'])
    assert.deepEqual(extensionSegments('教案.v2.pdf'), ['v2', 'pdf'])
  })
})

describe('文件名安全（§5 禁止路径穿越与双扩展名）', () => {
  for (const [name, why] of [
    ['../../etc/passwd', '路径穿越'],
    ['..\\..\\windows\\system32\\cmd.exe', 'Windows 风格穿越'],
    ['a/b.pdf', '正斜杠'],
    ['a\\b.pdf', '反斜杠'],
    ['test.pdf.exe', '双扩展名（危险段在后）'],
    ['test.exe.pdf', '双扩展名（危险段在前，只看最后一段就会放行）'],
    ['x.php.pdf', '脚本扩展名藏在中间'],
    ['payload.js.txt', 'js 藏在中间'],
    ['evil.html', 'HTML 直接是最终扩展名'],
    ['run.sh', 'shell 脚本'],
    ['setup.exe', '可执行文件'],
    ['\u0000a.pdf', 'NUL 字节'],
    ['a\nb.pdf', '换行（会污染响应头）'],
    ['', '空名字'],
    ['   ', '全空白'],
    [' a.pdf', '首部空格'],
  ]) {
    test(`拒绝：${name.replace(/\n/g, '\\n')}（${why}）`, () => {
      assert.notEqual(unsafeFileNameReason(name), null, `${name} 应当被拒绝`)
    })
  }

  test('允许：中文、空格、多点、连字符、括号', () => {
    for (const name of [
      '幼儿园美德课程教案.pdf',
      'My Lesson Plan (final).docx',
      '教案 v2 - 修订版.pptx',
      'a.b.c.pdf',
      '2026-10 观察记录.xlsx',
    ]) {
      assert.equal(unsafeFileNameReason(name), null, `${name} 应当被允许`)
    }
  })

  test('危险扩展名清单里包含业主点名的那些', () => {
    for (const ext of ['php', 'js', 'html', 'exe', 'sh']) {
      assert.equal(DANGEROUS_EXTENSIONS.includes(ext), true, `${ext} 必须在禁止清单里`)
    }
  })
})

describe('三者综合判定：扩展名 + MIME + magic bytes', () => {
  test('三者一致 → 通过', () => {
    assert.equal(ok({ headBytes: BYTES.pdf() }).ok, true)
    assert.equal(ok({ fileName: 'a.png', mimeType: 'image/png', headBytes: BYTES.png() }).ok, true)
    assert.equal(ok({ fileName: 'a.jpg', mimeType: 'image/jpeg', headBytes: BYTES.jpeg() }).ok, true)
    assert.equal(ok({ fileName: 'a.txt', mimeType: 'text/plain', headBytes: BYTES.text() }).ok, true)
    assert.equal(
      ok({ fileName: 'a.docx', mimeType: ALLOWED_FILE_TYPES[5].mime, headBytes: BYTES.zip() }).ok,
      true,
    )
    assert.equal(ok({ fileName: 'a.zip', mimeType: 'application/zip', headBytes: BYTES.zip() }).ok, true)
  })

  test('扩展名不在白名单 → 拒绝，并且**说得出是哪一类问题**', () => {
    // 危险扩展名（可执行 / 脚本 / 网页）先被"文件名安全"挡下，
    // 报的是 FILE_NAME_UNSAFE —— 这是因为错误信息会直接给老师看，
    // "文件名里不允许出现 .exe"比"不支持这种文件类型"更能让人知道该怎么办。
    for (const name of ['a.exe', 'a.html', 'a.js', 'a.php', 'a.sh', 'a.svg']) {
      const r = classifyFile({ fileName: name, mimeType: 'application/pdf', size: 10 })
      assert.equal(r.ok, false, `${name} 应当被拒绝`)
      assert.equal(r.code, 'FILE_NAME_UNSAFE', `${name} 应报"文件名不安全"`)
    }
    // 其余不认识但也不危险的扩展名，报"类型不支持"。
    for (const name of ['a.csv', 'a.md', 'a.pages', 'a.key']) {
      const r = classifyFile({ fileName: name, mimeType: 'application/pdf', size: 10 })
      assert.equal(r.ok, false, `${name} 应当被拒绝`)
      assert.equal(r.code, 'FILE_TYPE_NOT_ALLOWED', `${name} 应报"类型不支持"`)
    }
  })

  test('MIME 与扩展名矛盾 → 拒绝（不能声明什么就是什么）', () => {
    const r = classifyFile({ fileName: 'a.pdf', mimeType: 'text/html', size: 10 })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'FILE_TYPE_NOT_ALLOWED')
    assert.match(r.message, /与扩展名不符/)
  })

  test('**内容**与扩展名矛盾 → 拒绝（改名换姓在这里被挡住）', () => {
    // 一个可执行文件改名成 .pdf —— 只看扩展名与 MIME 都会放行。
    const r = ok({ headBytes: BYTES.elf() })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'FILE_TYPE_NOT_ALLOWED')
    assert.match(r.message, /内容与扩展名不符/)

    // 一个 HTML 改名成 .txt：内容是文本，所以**允许上传**——
    // 但预览时会以 text/plain + nosniff 返回，脚本不会执行（§36）。
    const html = classifyFile({
      fileName: 'a.txt',
      mimeType: 'text/plain',
      size: BYTES.html().length,
      headBytes: BYTES.html(),
    })
    assert.equal(html.ok, true)
  })

  test('zip 改名成 pdf → 拒绝', () => {
    const r = ok({ headBytes: BYTES.zip() })
    assert.equal(r.ok, false)
    assert.match(r.message, /压缩包/)
  })

  test('png 改名成 pdf / pdf 改名成 png → 都拒绝', () => {
    assert.equal(ok({ headBytes: BYTES.png() }).ok, false)
    assert.equal(
      classifyFile({ fileName: 'a.png', mimeType: 'image/png', size: 10, headBytes: BYTES.pdf() }).ok,
      false,
    )
  })

  test('不含 magic 的空白头不强判（申请上传地址时还没有字节）', () => {
    // headBytes 没给：只按扩展名 + MIME 判 —— 这正是"申请地址"那一步的能力边界，
    // 内容真伪留给 register 那一步（那里读得到对象）。
    assert.equal(ok({ headBytes: undefined }).ok, true)
    assert.equal(ok({ headBytes: new Uint8Array() }).ok, false)
  })
})

describe('容器识别', () => {
  test('认得 PDF / PNG / JPEG / ZIP / 文本，其余是 unknown', () => {
    assert.equal(detectContainer(BYTES.pdf()), 'pdf')
    assert.equal(detectContainer(BYTES.png()), 'png')
    assert.equal(detectContainer(BYTES.jpeg()), 'jpeg')
    assert.equal(detectContainer(BYTES.zip()), 'zip')
    assert.equal(detectContainer(BYTES.text()), 'text')
    assert.equal(detectContainer(BYTES.elf()), 'unknown')
  })

  test('含 NUL 的视为二进制，而不是"看起来像文本"', () => {
    assert.equal(detectContainer(Buffer.from([0x41, 0x00, 0x42])), 'unknown')
  })
})

describe('大小限制', () => {
  test('刚好到上限通过，超一个字节拒绝（413）', () => {
    assert.equal(ok({ size: MAX_FILE_SIZE_BYTES }).ok, true)
    const over = ok({ size: MAX_FILE_SIZE_BYTES + 1 })
    assert.equal(over.ok, false)
    assert.equal(over.code, 'FILE_TOO_LARGE')
    assert.equal(over.status, 413)
  })

  test('0 / 负数 / 非数字一律拒绝，不能因为"读不到大小"就放行', () => {
    for (const size of [0, -1, Number.NaN, Infinity, '100', undefined, null]) {
      const r = ok({ size })
      assert.equal(r.ok, false, `size=${String(size)} 应当被拒绝`)
    }
  })

  test('大小文案只有一份', () => {
    assert.equal(formatFileSize(0), '0 B')
    assert.equal(formatFileSize(999), '999 B')
    assert.equal(formatFileSize(2048), '2.0 KB')
    assert.equal(formatFileSize(MAX_FILE_SIZE_BYTES), '50.0 MB')
  })
})

describe('预览能力与 viewer', () => {
  test('每类文件用哪个 viewer', () => {
    assert.equal(viewerFor('a.pdf', 'application/pdf'), 'pdf')
    assert.equal(viewerFor('a.PNG', 'image/png'), 'image')
    assert.equal(viewerFor('a.jpeg', 'image/jpeg'), 'image')
    assert.equal(viewerFor('a.txt', 'text/plain'), 'text')
    assert.equal(viewerFor('a.docx', ALLOWED_FILE_TYPES[5].mime), null)
    assert.equal(viewerFor('a.zip', 'application/zip'), null)
  })

  test('提示语是业主指定的原文', () => {
    assert.equal(PREVIEW_UNSUPPORTED_MESSAGE, '此文件类型暂不支持在线预览，请下载查看。')
  })
})

describe('存储 key 里的文件名段（§7）', () => {
  test('保留中文，去掉会干扰路径的字符', () => {
    assert.equal(safeFileNameSegment('幼儿园美德教案.pdf'), '幼儿园美德教案.pdf')
    assert.equal(safeFileNameSegment('a b/c.pdf'), 'c.pdf')
    assert.equal(safeFileNameSegment('..\\..\\etc\\passwd'), 'passwd')
    assert.equal(safeFileNameSegment('a\u0000b.pdf'), 'ab.pdf')
    assert.equal(safeFileNameSegment('../../'), 'file')
    // 首部连续的点会被去掉，于是 `../` 不会以点开头残留
    assert.equal(safeFileNameSegment('...pdf').startsWith('.'), false)
  })

  test('过长的名字被截断，但仍保留扩展名可读的部分', () => {
    const long = `${'教'.repeat(200)}.pdf`
    const segment = safeFileNameSegment(long)
    assert.equal(segment.length <= 80, true, `实际长度 ${segment.length}`)
  })
})
