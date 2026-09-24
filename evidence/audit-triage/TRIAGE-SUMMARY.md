# npm audit HIGH 逐项 triage — 结论与证据

> 所有数字均来自本机实跑，未采信任何声明。原始数据与完整日志见本目录。
> 最后一次全量验证：`23-verify-final.txt`（无并发操作）；最终审计：`24-audit-final.json`；
> 最终 predeploy：`25-predeploy-final.txt`。

## 0. 总览

| 指标 | 升级前 | 最终 | 变化 |
|---|---|---|---|
| **HIGH** | **16** | **6** | **−10** |
| CRITICAL | 0 | 0 | 0 |
| moderate | 57 | 57 | **0**（回到升级前水平，无新增） |
| low | 3 | 3 | 0 |
| total | 76 | 66 | −10 |

**审计条目逐条 diff：新增条目 = 0。** 消失 6 条、严重度降级 3 条
（`@lark-apaas/fullstack-nestjs-core`、`@lark-apaas/nestjs-datapaas`、
`@nestjs/platform-express`：high → moderate，其 high 来源 multer/drizzle/body-parser 已修复）。
过程中一度出现 moderate +3，原因是降级后的包仍以 moderate 保留；最终随 body-parser/qs 修复一并归零。

---

## 1. 已修复（10 个包，全部有实测证据）

### 1.1 有真实生产代码路径关联的（优先处理）

| 包 | 前 → 后 | 公告 / 受影响范围 | 是否真实走到受影响路径 | 生产风险 | 修复方式 |
|---|---|---|---|---|---|
| `drizzle-orm` | 0.44.6 → **0.45.3** | CVE-2026-39356 / GHSA-gpj5-g38j-94v9，HIGH，`<0.45.2` | **否**：触发需把不可信输入传入标识符/别名构造。全仓：`sql.identifier(` **0 处**、动态 `.as(别名)` **0 处**、`orderBy` 全为静态 schema 对象；`sql` 模板里的 `${}` 全是**参数绑定**而非标识符 | 低（不可达）；但它是直接依赖且与生产代码同类别，故升级 | 直接依赖 + override |
| `qs` | 6.14.2 → **6.16.0** | 3 条 moderate：`>=6.11.1 <=6.15.1`、`>=6.14.2 <=6.15.3`、`>=2.2.5 <6.16.0`（DoS / array-limit 绕过 / `isBuffer` DoS） | **是** —— qs 是 Express 的**查询串解析器，位于请求路径上**。本轮唯一"可达"的一项，因此最值得修 | **中**（真实可达，需恶意查询串触发 DoS） | override；**决定性验证**：所有 express/body-parser 实例（含 `@nestjs/platform-express` 的嵌套 express@4.22.1）经 `createRequire` 实测**全部解析到同一个提升的 `qs@6.16.0`** |
| `body-parser`（根） | 1.20.4 → **1.20.8** | low，`<1.20.6`（无效 limit 值 DoS） | 部分：应用未设置自定义 `limit`，走默认值 | 低 | **作用域 override** `"body-parser@1.20.4": "1.20.8"` |
| `express` | 4.22.2 → **4.22.3** | express 自身**无公告**；升它是为了让 `qs` 约束从 `~6.15.1` 变为 `~6.16.0` | — | — | 直接依赖精确升级（patch 级） |

### 1.2 纯传递依赖 / 构建工具链

| 包 | 前 → 后 | 公告 / 范围 | 是否可达到 | 生产风险 | 修复方式 |
|---|---|---|---|---|---|
| `multer` | 2.0.2 → **2.4.0** | 7 条公告，HIGH 全部 `<2.3.0` | **否**：全仓无 `FileInterceptor`/`FilesInterceptor`/`AnyFilesInterceptor`/`@UploadedFile`/multipart 处理 → **不存在任何上传端点**，multer 中间件从未注册到任何路由 | 低（不可达） | override |
| `lodash` | 4.17.21（嵌套）→ **4.18.1** | GHSA-r5fr-rjxr-66jc 等，HIGH，`<=4.17.23` | 间接：应用 **0 处** import；消费者只用 `lodash/get|has|set`、`lodash.set|get`（稳定 API） | 低 | override（强制嵌套副本一并提升） |
| `js-yaml` | 4.1.0（嵌套）→ **4.3.2** | 3 条 HIGH，`>=4.0.0 <4.3.2` | 间接：应用 **0 处** import | 低 | override |
| `picomatch` | 4.0.1 → **4.0.7** | GHSA-c2c7-rcm5-vvqj，HIGH，`>=4.0.0 <4.0.4` | 间接：仅构建工具链（vite/rolldown/tinyglobby/@angular-devkit） | 低（dev） | override |
| `glob`（`@nestjs/cli` 下） | 10.4.5 → **10.5.0** | GHSA-5j98-mcp5-4vw2，HIGH，`>=10.2.0 <10.5.0`；仅 **glob CLI 的 `-c/--cmd`** | **否**：`@nestjs/cli` 编程式调用 glob，不走 CLI `-c`；且**不在生产树** | 无（dev-only） | **作用域 override** `"@nestjs/cli": { "glob": "10.5.0" }` |

---

## 2. 未修复 —— 明确记录，不隐藏

### R-1 `tmp@0.0.33`（HIGH：GHSA-ph9p-34f9-6g65，`<0.2.6`）

| 项 | 内容 |
|---|---|
| **受影响路径** | `@nestjs/cli@10.4.9` → `inquirer` → `external-editor@3.1.0` → `tmp@0.0.33`（`external-editor/main/index.js:131` 把构造参数 `fileOptions` 传给 `tmpNameSync()`） |
| **为什么升不了** | 修复版 `tmp@0.2.6+`（最新 0.2.7）。`external-editor` **全部 16 个已发布版本**都声明 `tmp@^0.0.33`；`^0.0.33` 在该包自身 **major=0** 语义下只允许 `0.0.x` 补丁。升 0.2.7 = 强制跨 major 且超出唯一消费者的声明范围。已核实**不存在同 major 的安全修复版**。 |
| **缓解** | ① **不在生产树**（`npm ls --omit=dev` 中 `tmp@` 命中 0 行），Docker 镜像用 `npm ci --omit=dev` → **生产镜像不含 tmp**；② **应用全局零 `child_process`**（已 grep `spawn`/`execFile`/`execSync` → 0 处），无触发点；③ `external-editor` 的 `fileOptions` 来自 CLI 调用方自身，本地开发者本已具备同等文件写权限；④ 仅服务于 `@nestjs/cli` 交互式编辑器，非交互构建/CI 不会走到。 |
| **残余风险** | 接受（dev-only，且无可用安全修复版本）。**若 `external-editor` 将来放宽 `tmp` 范围，应立即跟进。** |

### R-2 `@opentelemetry/sdk-node@0.208.0` + `@opentelemetry/exporter-prometheus@0.208.0`（HIGH：GHSA-q7rr-3cgh-j5r3，`<0.217.0`）

| 项 | 内容 |
|---|---|
| **受影响路径** | `@lark-apaas/observable@1.0.6`（`dependencies: @opentelemetry/sdk-node@^0.208.0`）→ `NodeSDK` |
| **可达性判定：不可达** | 读平台实际初始化代码（`node_modules/@lark-apaas/observable/dist/index.js:9092-9113`）：`new NodeSDK({ resource, logRecordProcessor, spanProcessor })` —— **仅**这三个参数，后两者都是它自己的 `CustomExporter` + `BatchSpanProcessor`。全树检索 `PrometheusExporter` / `exporter-prometheus` → **0 处引用**。公告要求**启动一个 Prometheus 导出端点**并接收畸形 HTTP 请求；本应用从不启动该监听器，触发条件不成立。 |
| **为什么升不了** | `0.208.x` 线**只有一个版本**（0.208.0）。修复首次出现在 **0.217.0**（2026-05-06，比 0.208.0 晚 7 个月，跨 9 个 0.x minor）。`@lark-apaas/observable` 的**每一个已发布版本**（1.0.0/1.0.2/1.0.3/1.0.4/1.0.5/1.0.6）都锁 `sdk-node@^0.208.0`，而 0.x 语义下 caret 不跨越 minor → `0.217.0` 超出其**声明范围**。已核实**不存在能消除该公告的平台版本**。 |
| **缓解** | 不在请求路径上、从不启动该导出端点（已用代码取证）。 |
| **残余风险** | 接受（不可达 + 无同线修复版 + 上游平台未跟进）。 |

### R-3 `@opentelemetry/propagator-jaeger@2.2.0`（HIGH：GHSA-45rx-2jwx-cxfr，`<2.9.0`）

| 项 | 内容 |
|---|---|
| **公告** | `JaegerPropagator` 因畸形 header 抛未捕获异常导致 DoS |
| **可达性判定：不可达** | 全树检索 `propagator-jaeger` / `JaegerPropagator` → **0 处引用**。它只作为 `sdk-node` 的依赖被安装；`NodeSDK` 构造时未传 `textMapPropagator`，平台自己的 trace 上下文由 `CustomTraceExporter` + 自定义 header 格式（`CUSTOM_FORMAT_REGEX`）处理。未实例化的 propagator 不会解析任何 header。 |
| **为什么升不了** | 同 R-2：版本线与 `sdk-node` 绑定，平台锁 `^0.208.0`；单独强推 `2.9.0` 会与 sdk-node 0.208.0 的内部 API 期望错配，且属无关升级。 |
| **残余风险** | 接受（不可达）。 |

### R-4 其余 moderate / low（均无同 major 修复版，或不在生产路径）

| 包 | 严重度 | 范围 | 为什么未修 |
|---|---|---|---|
| `file-type` | moderate | `>=13.0.0 <21.3.1`（ASF 解析死循环）、`>=20.0.0 <=21.3.1`（ZIP 解压炸弹） | 修复仅在 **21.3.1**（2026-03-09）；`20.x` 线最后版本是 **20.5.0** → **21 是 major 跳跃**。消费者 `@nestjs/common@10.4.22` 精确锁 `file-type@20.4.1`。**注意**：该包被 `@nestjs/common` 的 `FileTypeValidator` 使用，若将来接入上传校验，应重新评估本项。 |
| `@nestjs/core` | moderate | `<=11.1.17`（输出元素中和不当） | 全 10.x 线均无修复（修复在 11.1.17 之后）→ 需跨 major 升级整个 Nest，被明确禁止。 |
| `@hey-api/openapi-ts` | moderate | `<0.97.3`（原型链污染） | 由 `@lark-apaas/fullstack-nestjs-core` 间接引入；升级需平台包更新。 |
| `ajv` | moderate | `>=7.0.0-alpha.0 <8.18.0`（`$data` 选项 ReDoS） | 消费者为 `@angular-devkit/core`（`@nestjs/cli` 下，dev-only）；应用不直接使用 ajv 的 `$data`。 |
| `@opentelemetry/core` | moderate | `<2.8.0`（W3C Baggage 无界内存分配） | 与 R-2 同源，平台锁版本线。 |
| `webpack` | low | `buildHttp` allowedUris 绕过 | 仅 `@nestjs/cli` 的 dev server 使用，生产不加载。 |
| `@types/qs` | 类型包 | — | 类型定义停在 6.15.1（`@types/qs` 最新版就是 6.15.1，**不存在 6.16.0**）。无法对齐，仅类型层面，无运行时影响。曾尝试 override 到 6.16.0，因包不存在而安装失败，已回退。 |

---

## 3. 修改清单（最小必要）

`package.json` → `overrides` 新增 8 条（含 2 条作用域形式）：

```json
"multer": "2.4.0",
"js-yaml": "4.3.2",
"picomatch": "4.0.7",
"lodash": "4.18.1",
"drizzle-orm": "0.45.3",
"@nestjs/cli": { "glob": "10.5.0" },
"qs": "6.16.0",
"body-parser@1.20.4": "1.20.8"
```

外加直接依赖：`dependencies.drizzle-orm` 0.44.6→0.45.3、`dependencies.express` →4.22.3（精确）、
`devDependencies.lodash` ^4.17.21→4.18.1（EOVERRIDE 规则要求 override 与直接依赖一致）。

**没有**修改：审计门禁逻辑、`predeploy-check.sh` 的任何阈值、任何 `catch {}` 吞错路径。
门禁仍然如实报告 `FAIL [20] npm audit reports 6 HIGH`。

## 4. 作用域问题的两次修正（记录，因为第一版都是错的）

| 轮次 | 错误 | 后果 | 修正 |
|---|---|---|---|
| `glob` | 用**全局** `overrides.glob = 10.5.0` | 把 `react-dev-utils` 的嵌套 `glob` 从 **7.2.3 跨大版本拉到 10.5.0** | 改为 `overrides['@nestjs/cli'].glob`；`react-dev-utils` 的 `glob@7.2.3` 回到未变 |
| `body-parser` | 用**全局** `overrides['body-parser'] = 1.20.8` | 把 `@modelcontextprotocol/sdk`（**生产依赖**，经 `@lark-apaas/nestjs-mcp`）的嵌套 `body-parser@2.3.0` **降级到 1.20.8** | 改为作用域形式 `"body-parser@1.20.4": "1.20.8"`；`@modelcontextprotocol/sdk` 的 `body-parser@2.3.0` 恢复 |

两次都是"全局 override 波及范围外消费者"，与"不做无关大版本升级"直接冲突，已修正并复验。

## 5. lockfile diff

| 类别 | 内容 |
|---|---|
| **版本变化（9）** | `drizzle-orm` 0.44.6→0.45.3 · `multer` 2.0.2→2.4.0 · `picomatch` 4.0.1→4.0.7 · `express` 4.22.2→4.22.3 · `body-parser` 1.20.4→1.20.8 · `qs` 6.14.2→6.16.0 · `@nestjs/cli/node_modules/glob` 10.4.5→10.5.0 · `brace-expansion` 5.0.9→5.0.12 · `lru-cache` 11.5.2→11.5.3 |
| **新增（2）** | `lru-cache@10.4.3`、`react-dev-utils/…/glob@7.2.3`（后者是"被误升后恢复原状"） |
| **移除（16）** | 已修复的嵌套副本：`@nestjs/swagger/{lodash,js-yaml}`、`@nestjs/config/lodash`、3×嵌套 `picomatch@2.3.2`、`express/node_modules/{body-parser@1.20.6,qs@6.15.3}`、`@modelcontextprotocol/sdk/node_modules/qs@6.16.0`（提升）等 |
| **哈希** | before `cd99cf97…` → after `669195c7…`（`00-lockfile-*.sha256`） |

`brace-expansion` / `lru-cache` 是 **glob override 的附带解析**（`glob → minimatch → brace-expansion`、
`glob → path-scurry → lru-cache`），均为 **patch 级、无安全公告**（已查询确认）。

`npm ci --omit=dev --dry-run` → **rc=0**（lockfile 与 package.json 同步，Docker 构建前置条件成立）。

## 6. 验证证据

每次升级后都跑：`npm test` · `typecheck server` · `typecheck client` · `npm run build` ·
全部 HTTP 安全套件（`scripts/verify-all.sh`）· predeploy。

最终一次（`23-verify-final.txt`，**所有变更定稿、无并发操作**）全部通过：

```
drizzle API 闸门     PASS
npm test             230/230  (skipped 0)
typecheck server     PASS
typecheck client     PASS
npm run build        PASS
api-contracts        matched
authz-http           74/74
hardening            10/10
mfa                  55/55
security-headers     20/20
files-http           73/73
naming-http          49/49
```

**一次失败的假象，一并记录**：中途有一次后台验证出现 `build FAIL`、`npm test pass=225`、
readiness 503。原因是该验证与我的 `npm install`（body-parser 作用域修正）**并发**执行，
安装中途替换了 `node_modules`。已确认不是真实回归：串行重跑后全部通过。
教训：**依赖安装与门禁绝不能并发**。

最终 predeploy（`25-predeploy-final.txt`）：`NOT READY FOR PRODUCTION`，退出码 1，
20 项检查中 7 FAIL / 1 WARN，其中 `FAIL [20] npm audit reports 6 HIGH` —— **门禁未被放宽**。

## 7. 顺带发现的工具/环境缺陷（非依赖问题，但会假性阻塞构建）

本机 `npm install` 会按 **linux/x64 专用**的 lockfile 剪掉 macOS/arm64 原生绑定
（`@swc/core-darwin-arm64`、`@rolldown/binding-darwin-arm64`、`lightningcss-darwin-arm64`、
`@tailwindcss/oxide-darwin-arm64`），导致 `npm run build` 报
`Failed to load "@swc/cli" and/or "@swc/core"`。
这是 lockfile 为发布目标平台生成、开发机是另一平台的**必然结果**
（`DEPLOYMENT_PRODUCTION.md` §6/§7.2 已记录同一现象，并明确要求**不要**为本机重建 lockfile）。

新增 `scripts/repair-local-native-bindings.sh`（含 `--check` 模式）修复，
**不修改 package.json / package-lock.json**。

## 8. 新增的防回归闸门

`scripts/ci-check-drizzle-api.mjs` —— drizzle-orm 是**精确锁定**的 peer 依赖
（`@lark-apaas/fullstack-nestjs-core` 与 `@lark-apaas/nestjs-datapaas` 都声明 `"drizzle-orm": "0.44.6"`，
无 caret），而修复在 0.45.2，因此本次升级是一个**被迫的 peer 偏差**。
该脚本验证平台 monkey patch 依赖的内部符号在升级后仍然存在：
`drizzle-orm/postgres-js` 的 `PostgresJsPreparedQuery.prototype.execute` —— 该符号缺失会让
`@lark-apaas/nestjs-datapaas` 的 `applyDrizzleMonkeyPatch()` 在启动时直接抛错。
升级前后均运行，均 PASS。

**已知局限（不掩饰）**：这是**符号存在性**检查，**不是行为等价性检查**。
`PostgresJsPreparedQuery` 存在但语义变化的情况本脚本发现不了 —— 那只能由平台上真实请求路径验证。
