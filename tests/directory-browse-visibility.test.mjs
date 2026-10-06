/**
 * 目录浏览的资源可见性 —— 两条**静态**不变式。
 *
 * WHY THIS FILE EXISTS（一次文档与实现不一致，且是一个真实的信息泄露面）
 * --------------------------------------------------------------------
 * 我在报告里写过"浏览视图只列 published，与被我删掉的那些页面口径一致"。
 * 但 `DirectoryBrowser.tsx` 里的那次 `getResources()` **根本没有传 `status`** ——
 * 文档说一套、代码做一套，而**没有任何测试会发现**：不传 status 不报错，
 * 只是多返回了行。
 *
 * 多返回的是什么，值得写清楚：服务端 `listResources` 的条件只有
 * 「未软删 + 科目权限 + 目录子树」，**状态过滤只在调用方传了 status 时才加**
 * （见 `server/modules/resources/resources.service.ts` 里 conditions 的构造）。
 * 所以不传 status 的语义是"同科目下**所有人、所有状态**的资源" ——
 * 包括**别的老师还没提交审核的草稿**。这不是风格问题，是可见性边界。
 *
 * 修法：显式传 `status: 'published'`（对外只列已发布）；
 * 老师**自己的**未发布资源由 `getMyResources()`（服务端按 uploaderId 过滤，
 * 结构上不可能返回别人的行）单独合并进来，并在界面上注明"只有你能看到"。
 * 这样 §15 要求的「上传 → 保存 → 资源出现在该目录」也成立 ——
 * 否则老师刚传完回目录一看什么都没有，会以为东西丢了。
 *
 * 这个测试用**源码断言**把两件事钉住，因为它们是"参数在不在"这种
 * 静态事实，用浏览器断言反而绕远：
 *   1. 目录查询必须带 `status: 'published'`；
 *   2. 必须有 `getMyResources` 的合并（否则自己的草稿永远看不见，
 *      §15 那条链路会静默失效）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER = join(ROOT, 'client', 'src', 'directory', 'DirectoryBrowser.tsx');
const SRC = readFileSync(BROWSER, 'utf8');

/**
 * 去掉注释后再做"不得出现某种写法"的匹配。
 *
 * 必须这么做，而且这次的坑是**自己踩的**：我在这段代码旁边写了一句注释
 * 「第一版这里是 `if (total === 0)`」，于是"不得出现"的断言匹配到了**注释里的示例**，
 * 测试红了，而代码其实是对的。
 * 一条"文档写得越清楚越容易失败"的守卫是不可接受的 —— 它最终会被人删掉。
 *
 * 实现会跳过字符串/模板串，避免把 `'http://…'` 里的 `//` 当成注释开头，
 * 把后面真正的代码一起吃掉（那是**漏报**，比误报更危险）。
 * 同一套做法见 `tests/client-role-gate.test.mjs`。
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i += 1;
      while (i < n) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const CODE = stripComments(SRC);

describe('目录浏览的资源可见性（§8/§15）', () => {
  test('目录查询必须显式带 status=published（否则会列出别人的草稿）', () => {
    assert.match(
      SRC,
      /resourcesApi\.getResources\(\{[\s\S]{0,400}?status:\s*'published'/,
      'DirectoryBrowser 的 getResources() 没有传 status: \'published\'。\n' +
        '服务端只按科目权限过滤、不按状态过滤，所以省掉这个参数等于把\n' +
        '**同科目下所有人所有状态的资源**都列出来 —— 包含别的老师未提交审核的草稿。\n' +
        '这不是"少写一个参数"，是可见性边界。请补上，并保留 getMyResources 的合并\n' +
        '（老师自己的未发布资源要能看见，否则"传完像丢了"）。',
    );
  });

  test('必须合并"我自己的未发布资源"（否则 §15 的上传闭环静默失效）', () => {
    assert.match(
      SRC,
      /getMyResources\s*\(/,
      'DirectoryBrowser 没有调用 getMyResources()。\n' +
        '只列 published 会让老师刚保存的草稿在自己的目录里看不到 ——\n' +
        '§15 要求「上传资源 → 保存 → 资源出现在该目录」，这条链路会静默失效。\n' +
        '服务端 getMyResources 按 uploaderId 过滤，结构上不会返回别人的行，因此安全。',
    );
    assert.match(
      SRC,
      /directory-mine-note/,
      '合并了"我的未发布"却没有任何界面说明。老师会以为这个资料夹里的草稿别人也看得到，\n' +
        '或者反过来以为它就是已发布内容。请保留那段说明（只有你能看到）。',
    );
  });

  test('判空不得只看已发布条数（否则草稿会被空态挡掉）', () => {
    // 曾经写成 `if (total === 0)` —— total 是**已发布**条数，
    // 于是"资料夹里只有我自己的草稿"时，界面显示"暂无资源"，
    // 因为 empty 分支在渲染 items 之前就 return 了。
    assert.doesNotMatch(
      CODE,
      /if\s*\(\s*total\s*===\s*0\s*\)/,
      '空态判断又回到了 `total === 0`。total 只是已发布条数，\n' +
        '而列表里还可能有"我自己的未发布"行 —— 那样会显示"暂无资源"却同时有卡片。',
    );
  });
});
