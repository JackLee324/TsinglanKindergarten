# V1 已知限制（记录在案，**V1 不再修改**）

> 业主决定：V1 当前保持**冻结**。本文只做记录，不是待办清单。
> 目的是避免后来者（人或 agent）看到 V1 的偶发红灯时，去改一个已经
> 上线的版本 —— 那会把"一个已知的测试竞态"换成"一次未经审查的生产变更"。

## 1. `verify-ia-consolidation.mjs` 的异步等待竞态

**现象**

门禁里的 `ia-consolidation` 套件**偶发**两条假红：

```
FAIL  侧边栏班型名来自数据库（Pre-K）  -> null
FAIL  侧边栏科目名来自数据库（美德）  -> null
```

**实测记录**

| 运行方式 | 结果 |
|---|---|
| V1 完整门禁（第 1 次，V2 加入前） | 通过（75/75） |
| V1 完整门禁（第 2 次，V2 加入后） | **偶发 2 条假红** |
| V1 完整门禁（第 3 次，V2 加入后） | 通过（75/75） |
| 单独重跑 `node scripts/verify-ia-consolidation.mjs` | 每次都通过 |

**根因**

`scripts/verify-ia-consolidation.mjs:330`：

```js
const navPrek = await text('[data-nav="/directory/prek"]');   // ← 读之前没有等待
if (navPrek === 'Pre-K') ok(...)
```

侧边栏的目录树是登录后**异步**取的（`DirectoryProvider` 发
`GET /api/directories/tree`）。在门禁里，这个套件排在 19 个套件之后，
机器更忙、首帧更慢，于是"读得比渲染早"时 `querySelector` 返回 `null`。

同一个文件里 `expandGroup` 上方的注释其实已经写明了这个道理
（"直接 querySelector 得到 null 只说明'还没渲染'"），只是那两行读取漏了等待。

**影响评估**

- 只影响**测试**，不影响 V1 的任何线上行为；
- 门禁仍然会以非零退出码失败（不会静默变绿），只是失败信息会指向一个假原因；
- 连续重跑即可通过。

**建议的修法（一行，但本轮**不做**）**

```js
await waitFor('!!document.querySelector(\'[data-nav="/directory/prek"]\')', 15000)
const navPrek = await text('[data-nav="/directory/prek"]')
```

**为什么本轮不改**

V1 已冻结、已推送（`main` = `72015a3`，其后 `dadf633` 只增加 V2 文档），
且该缺陷不影响生产行为。业主明确要求：**不要为了修这个竞态而修改 V1**。

## 2. V1 的其他已知限制（引自 V1 的 `FINAL_COMPLETION_REPORT.md`）

这些同样**不在 V2 阶段 2 的范围内**，列出以免混淆：

1. V1 不支持"新增科目型节点"（V2 通过通用目录树解决）。
2. 生产上有 347 条"只到科目层"的历史资源未迁移（V1 按设计只报告不篡改）。
3. `data-export` 没有界面（V1 标记为 INTERNAL-ONLY）。
4. V1 生产仍部署在 `f5d0a06`，本轮未重新部署。

## 3. 与 V2 的关系

**无关。** V2 是 `V2/` 下的独立实现：

- 不 import V1 的任何代码；
- 不读写 V1 的数据库（V2 用 `qls_v2_dev` / `qls_v2_test`）；
- V2 的存在不改变 V1 的任何文件（`git diff -- . ':(exclude)V2'` 为空）。

V2 自己的浏览器验收（阶段 11）从一开始就用 `waitFor` 等待元素出现，
不重复这个竞态。
