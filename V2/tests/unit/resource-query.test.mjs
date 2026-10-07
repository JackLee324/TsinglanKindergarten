/**
 * tests/unit/resource-query.test.mjs —— 资源查询的纯逻辑 + 「没有第二套分类」的结构证明
 * ============================================================================
 * 分页与分栏这两件事前后端必须**完全一致**：前端要渲染页码、要渲染分栏，
 * 如果两边各算一遍，迟早会出现"界面说有 3 页、接口只给 2 页"。
 * 所以它们都在 `shared/resource-query.ts` 里，这里直接测那一份。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resourceQuery } from '../helpers/modules.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('服务端分页的计算', () => {
  const { computeTotalPages, clampPage, MAX_PAGE_SIZE } = resourceQuery

  test('整除与不整除', () => {
    assert.equal(computeTotalPages(20, 20), 1)
    assert.equal(computeTotalPages(21, 20), 2)
    assert.equal(computeTotalPages(40, 20), 2)
    assert.equal(computeTotalPages(41, 20), 3)
  })

  test('**空结果返回 1 页而不是 0 页**（界面显示"第 1 页 / 共 1 页"比"共 0 页"合理）', () => {
    assert.equal(computeTotalPages(0, 20), 1)
    assert.equal(computeTotalPages(-5, 20), 1)
  })

  test('pageSize 非法时不会产生 Infinity 或 0', () => {
    assert.equal(computeTotalPages(10, 0), 10)
    assert.equal(computeTotalPages(10, -3), 10)
    assert.equal(computeTotalPages(10, Number.NaN), 10)
  })

  test('页码被收进合法区间', () => {
    assert.equal(clampPage(1, 3), 1)
    assert.equal(clampPage(5, 3), 3)
    assert.equal(clampPage(0, 3), 1)
    assert.equal(clampPage(-2, 3), 1)
    assert.equal(clampPage(2.7, 3), 2)
  })

  test('每页上限是一个明确的正数（防止一次拉全库）', () => {
    assert.equal(MAX_PAGE_SIZE, 100)
  })
})

describe('「我的资源」的分栏与业主清单一致', () => {
  const { MY_RESOURCE_TABS } = resourceQuery

  test('六栏，顺序固定', () => {
    assert.deepEqual(
      MY_RESOURCE_TABS.map((t) => `${t.key}:${t.label}`),
      [
        'ALL:全部',
        'DRAFT:草稿',
        'PENDING_REVIEW:待审核',
        'PUBLISHED:已发布',
        'REJECTED:已退回',
        'RECALLED:已撤回',
      ],
    )
  })

  test('只有「全部」不带状态，其余各自对应一个状态', () => {
    const all = MY_RESOURCE_TABS.find((t) => t.key === 'ALL')
    assert.equal(all.status, null)
    for (const tab of MY_RESOURCE_TABS.filter((t) => t.key !== 'ALL')) {
      assert.equal(tab.status, tab.key)
    }
  })
})

describe('资源只有一个分类真相（结构性证明）', () => {
  const serverFiles = (() => {
    const out = []
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.ts')) out.push(full)
      }
    }
    walk(join(ROOT, 'server'))
    walk(join(ROOT, 'shared'))
    return out
  })()

  test('全仓库没有第二套资源分类表（FOLDER_TYPES / SUBJECT_RESOURCE_TYPES / PROGRAM_RESOURCE_TYPES）', () => {
    const banned = [
      'FOLDER_TYPES',
      'SUBJECT_RESOURCE_TYPES',
      'PROGRAM_RESOURCE_TYPES',
      'RESOURCE_TYPES_BY_SUBJECT',
      'folderTypeMap',
    ]
    const offenders = []
    for (const file of serverFiles) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      for (const name of banned) {
        if (code.includes(name)) offenders.push(`${relative(ROOT, file)}: ${name}`)
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `出现了第二套资源分类：\n  ${offenders.join('\n  ')}\n` +
        '资源的分类只有一处真相：它挂在哪个 Directory 节点上。',
    )
  })

  test('resources 表里没有 program / subject / folder_type 这类分类列', () => {
    const sql = readdirSync(join(ROOT, 'database', 'migrations'))
      .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
      .map((f) => readFileSync(join(ROOT, 'database', 'migrations', f), 'utf8'))
      .join('\n')
      .replace(/--[^\n]*/g, '')
    const block = sql.slice(sql.indexOf('CREATE TABLE resources'))
    const table = block.slice(0, block.indexOf(');'))
    for (const banned of ['program', 'subject', 'folder_type', 'sub_subject']) {
      assert.ok(
        !new RegExp(`\\b${banned}\\b`, 'i').test(table),
        `resources 表里不该有 ${banned} 列`,
      )
    }
  })
})

// 让 `statSync` 的导入不被 lint 判为未使用（walk 只用 Dirent.isDirectory）
void statSync
