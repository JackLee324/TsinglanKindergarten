#!/usr/bin/env node
/**
 * scripts/ci-forbidden-write-patterns.mjs — 写操作规则表 + 检查组
 * =================================================================
 *
 * 为什么规则表要单独成一个文件
 * ---------------------------
 * 规则表由**正则字面量与关键字字面量**构成。若把它写进被检查的文件里，规则会命中
 * 规则自己，检查就永远报错 —— 一个永远报错的检查等于没有检查。
 *
 * 曾试过用文本标记（START/END 注释行）把规则表排除出扫描范围，但那些标记行本身
 * 会在"先剥注释"这一步被删掉，偏移随之漂移，排除区间落到别处，实测仍然自我命中。
 * 把规则表移出被扫描的文件，是唯一不依赖偏移算术的做法。
 *
 * 用途
 * ----
 *   node scripts/ci-forbidden-write-patterns.mjs <已剥注释的文件>
 *   → stdout 输出 {"hits":[...]}，hits 为空数组表示通过
 *
 * 调用方：scripts/bootstrap-super-admin.mjs 的只读自查。
 * 该脚本的契约是"不含写入能力"，本文件是这条契约的判定依据。
 *
 * ⚠️ 修改本文件等于修改那个契约。任何新增例外都必须是有意的、可评审的。
 */

import { readFileSync } from 'node:fs';

/**
 * 三种"具备写入能力"的代码形态。
 *
 * 注意：这里检查的是**会真正执行**的代码形态，不是"文件里出现过某个单词"。
 * 给操作者看的示例 SQL 放在 .sql.txt 文件里、注释里、或字符串字面量里都不会命中，
 * 因为调用方在扫描前已剥掉注释与字符串字面量 —— 那些从不执行。
 */
const FORBIDDEN = [
  {
    // 驱动上的任意 SQL 逃生舱。一旦存在，只读保证就只剩脚本自己的纪律。
    pattern: new RegExp('\\.unsafe' + '\\s*\\('),
    why: '调用 .unsafe() —— 任意 SQL 执行能力，会绕过只读事务之外的一切约束',
  },
  {
    // 以函数形式调用 sql(...)（模板标签 sql`...` 是安全的参数绑定，不命中）
    pattern: new RegExp('(^|[^A-Za-z0-9_$.])sql' + '\\s*\\('),
    why: '以函数形式调用 sql(...)',
  },
  {
    // 语句构造中出现的写操作关键字
    pattern: new RegExp(
      '\\b(' +
        'INSERT' + '\\s+INTO' +
        '|UPDATE' + '\\s+\\w+\\s+SET' +
        '|DELETE' + '\\s+FROM' +
        '|ALTER' + '\\s+TABLE' +
        '|DROP' + '\\s+(TABLE|ROLE|FUNCTION)' +
        '|TRUNCATE' +
        '|GRANT' + '\\s+\\w+\\s+TO' +
        '|CREATE' + '\\s+ROLE' +
        ')\\b',
      'i',
    ),
    why: '语句构造中出现写操作关键字',
  },
];

const target = process.argv[2];
if (!target) {
  process.stdout.write(
    JSON.stringify({ error: 'usage: ci-forbidden-write-patterns.mjs <file>' }) + '\n',
  );
  process.exit(0);
}

let text;
try {
  text = readFileSync(target, 'utf8');
} catch (error) {
  process.stdout.write(
    JSON.stringify({ error: `无法读取待检文件: ${String(error.message).split('\n')[0]}` }) + '\n',
  );
  process.exit(0);
}

// 剥掉字符串字面量后再判定：字符串里出现的写关键字**从不执行**
// （本仓库里有大量这种"给操作者看的示例 SQL"），把它算作能力是误报。
// 与调用方剥注释的目的一致：只对**会执行的代码**负责。
const code = text
  .replace(/'(?:[^'\\]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\]|\\.)*"/g, '""')
  .replace(/`(?:[^`\\]|\\.)*`/g, '``');

const hits = [];
for (const rule of FORBIDDEN) {
  const m = rule.pattern.exec(code);
  if (!m) continue;
  // 报出上下文，便于定位（不打印整行，避免刷屏）
  const idx = m.index;
  const excerpt = code.slice(Math.max(0, idx - 40), idx + 60).replace(/\s+/g, ' ').trim();
  hits.push(`${rule.why}   [上下文: …${excerpt}…]`);
}

process.stdout.write(JSON.stringify({ hits }) + '\n');
process.exit(0);
