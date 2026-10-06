/**
 * legacy folder_type 映射（§7/§9）—— 单元级验证。
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * 这张映射表在"看起来做完了"的状态下**整个上传功能是坏的**：
 * `folderTypeFromDirectoryNode()` 用 `code.split(':').pop()` 取后缀，
 * 而官方资料夹的 code 是 `prek:virtue_outline`（末段 `virtue_outline`），
 * 表的键却是 `outline` —— 于是它**永远返回 null**，每次新建资源都 400。
 *
 * 单元测试当时只断言了"表里没有 research_archive"这类**静态事实**，
 * 所以它跟着错的实现一起绿。这个文件改成**用真实 code 形态走一遍推导**，
 * 于是"表的键"和"真实 code"一旦不匹配就立刻红。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('§7/§9 legacy folder_type 映射', () => {
  let mod;

  test('模块可加载', () => {
    mod = require('../dist/server/modules/directories/legacy-folder-mapping.js');
    assert.ok(mod, '构建产物应包含 legacy-folder-mapping.js（先 npm run build）');
  });

  test('自检函数通过（真实 code 形态 → 预期的 legacy 值）', () => {
    assert.doesNotThrow(() => mod.assertLegacyFolderMappingIntegrity());
  });

  test('四个官方资料夹后缀逐一推导正确', () => {
    const cases = [
      ['prek:virtue_outline', 'curriculum_outline'],
      ['prek:virtue_lesson', 'weekly_plans'],
      ['prek:virtue_resource', 'courseware'],
      ['prek:virtue_assessment', 'observation'],
      ['k:chinese:reading_lesson', 'weekly_plans'],
      ['k:chinese:arts_resource', 'courseware'],
      ['k:english_outline', 'curriculum_outline'],
      ['prek:pe_assessment', 'observation'],
    ];
    for (const [code, expected] of cases) {
      const got = mod.folderTypeFromDirectoryNode({ code, name: '任意中文名', type: 'folder' });
      assert.equal(got, expected, `${code} 应推导为 ${expected}，实际 ${String(got)}`);
    }
  });

  test('推导只看 code，不看中文显示名（改名不会破坏分类）', () => {
    const a = mod.folderTypeFromDirectoryNode({ code: 'prek:virtue_lesson', name: '教学详案', type: 'folder' });
    const b = mod.folderTypeFromDirectoryNode({ code: 'prek:virtue_lesson', name: '随便改了个名字', type: 'folder' });
    assert.equal(a, b, '显示名可改（§5），分类必须不受影响');
    assert.equal(b, 'weekly_plans');
  });

  test('自建文件夹沿祖先链推导', () => {
    assert.equal(
      mod.folderTypeForCustomFolder(['prek:virtue_lesson', 'prek:virtue']),
      'weekly_plans',
    );
    assert.equal(
      mod.folderTypeForCustomFolder(['prek:virtue_resource', 'prek:virtue']),
      'courseware',
    );
    // 祖先链里没有任何官方资料夹 → 必须返回 null，让调用方**报错**而不是猜
    assert.equal(mod.folderTypeForCustomFolder(['prek:virtue', 'prek']), null);
  });

  test('非 folder 类型不推导', () => {
    assert.equal(mod.folderTypeFromDirectoryNode({ code: 'prek:virtue', name: '美德', type: 'subject' }), null);
    assert.equal(mod.folderTypeFromDirectoryNode({ code: 'prek', name: 'Pre-K', type: 'program' }), null);
    assert.equal(mod.folderTypeFromDirectoryNode({ code: 'root:edu', name: '教育教学', type: 'root' }), null);
  });

  test('§9：research_archive 不在映射表里（PDF 无对应，不得硬猜）', () => {
    const types = mod.LEGACY_FOLDER_MAPPING_ENTRIES.map((e) => e.folderType);
    assert.ok(!types.includes('research_archive'), 'research_archive 不得出现在映射表中');
    assert.equal(types.length, 4, '映射表恰好四条（课程大纲/教学详案/教学资源/考核评估）');
    // 反向：没有任何 code 会被推导成 research_archive
    for (const suffix of ['outline', 'lesson', 'resource', 'assessment', 'research', 'archive']) {
      const got = mod.folderTypeFromDirectoryNode({
        code: `prek:virtue_${suffix}`, name: 'x', type: 'folder',
      });
      assert.notEqual(got, 'research_archive', `${suffix} 不得映射到 research_archive`);
    }
  });

  test('PDF 资料夹名逐字（§4）', () => {
    const names = mod.LEGACY_FOLDER_MAPPING_ENTRIES.map((e) => e.pdfFolderName).sort();
    assert.deepEqual(names, ['教学详案', '教学大纲占位', '教学资源', '考核评估', '课程大纲']
      .filter((n) => n !== '教学大纲占位').sort());
  });
});
