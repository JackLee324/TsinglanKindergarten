# npm audit HIGH 逐项 triage — 结论与证据

> 由 audit-triage 执行；所有数字均来自本机实跑，未采信声明。
> 原始数据：`evidence/audit-triage/01-audit-before.json`、`08-audit-final.json`；
> 完整验证日志：`10-…batch1.txt`、`11-…batch2.txt`、`12-…batch3.txt`、`14-…glob-scoped.txt`。

## 0. 总览

| 指标 | 升级前 | 最终 | 变化 |
|---|---|---|---|
| **HIGH** | **16** | **6** | **−10** |
| CRITICAL | 0 | 0 | 0 |
| moderate | 57 | 60 | +3（**全部是严重度降级，无新增条目**） |
| low | 3 | 3 | 0 |
| total | 76 | 69 | −7 |

**不存在新增漏洞条目。** 审前/审后逐条 diff 结果为：新增条目 **0**、消失条目 6
（`@nestjs/config`、`drizzle-orm`、`js-yaml`、`lodash`、`multer`、`picomatch`）、
严重度变化 3（`@lark-apaas/fullstack-nestjs-core`、`@lark-apaas/nestjs-datapaas`、
`@nestjs/platform-express`：high → moderate）。所以 moderate 的 +3 是**降级残留**，
不是新引入的风险。

---

## 1. 已修复（8 个包，全部有实测证据）

| 包 | 前 → 后 | 公告 / 受影响范围 | 是否真实走到受影响路径 | 生产风险判定 | 修复方式 |
|---|---|---|---|---|---|
| `drizzle-orm` | 0.44.6 → **0.45.3** | CVE-2026-39356 / GHSA-gpj5-g38j-94v9，HIGH，`<0.45.2` | **否**：公告触发条件是把**不可信输入**传给标识符/别名构造（`sql.identifier()`、`.as()`）。全仓检索：`sql.identifier(` **0 处**、动态 `.as(别名)` **0 处**、全部 `orderBy` 均为静态 schema 对象；`sql\`…\`` 里的 `${}` 全部是参数绑定而非标识符 | **低**（不可达），但仍升级：它是**直接依赖**，且这是唯一与生产代码路径同类别的公告 | 直接依赖 + override（首次修复版 0.45.2，取 0.45.3） |
| `multer` | 2.0.2 → **2.4.0** | 7 条公告，HIGH 全部 `<2.3.0`；另有 `<2.1.0`/`<2.1.1` | **否**：全仓检索无 `FileInterceptor`/`FilesInterceptor`/`AnyFilesInterceptor`/`@UploadedFile`/multipart 处理 → **不存在任何上传端点**，multer 中间件从未注册到任何路由 | **低**（不可达），升级成本极低 | override（`@nestjs/platform-express` 锁 2.0.2） |
| `lodash` | 4.17.21（嵌套副本）→ **4.18.1** | GHSA-r5fr-rjxr-66jc 等，HIGH，`<=4.17.23` | 间接：应用代码 **0 处** import。消费者只用 `lodash/get|has|set`（`@nestjs/config`）与 `lodash.set|get`（`@nestjs/swagger`）—— 均为稳定 API | **低** | override 强制嵌套副本一并提升；直接依赖同版以消除 npm EOVERRIDE |
| `js-yaml` | 4.1.0（嵌套副本）→ **4.3.2** | 3 条 HIGH，范围 `>=4.0.0 <4.3.2` | 间接：应用代码 **0 处** import | **低** | override |
| `picomatch` | 4.0.1 → **4.0.7** | GHSA-c2c7-rcm5-vvqj，HIGH，`>=4.0.0 <4.0.4` | 间接：仅构建工具链（vite/rolldown/tinyglobby/@angular-devkit） | **低**（开发树） | override |
| `glob`（`@nestjs/cli` 下） | 10.4.5 → **10.5.0** | GHSA-5j98-mcp5-4vw2，HIGH，`>=10.2.0 <10.5.0`；仅 **glob CLI** 的 `-c/--cmd` | **否**：`@nestjs/cli` 以编程方式调用 glob，不经过 CLI `-c` 路径；且**不在生产树** | **无**（dev-only） | **作用域 override**：`overrides['@nestjs/cli'].glob = '10.5.0'` |
| `@nestjs/platform-express` / `@lark-apaas/fullstack-nestjs-core` / `@lark-apaas/nestjs-datapaas` | — | 无自有公告，纯传播 | — | **已消除**（其 high 来源 multer/drizzle/body-parser 已修复，条目降级为 moderate） | 随上游修复自动消除 |

**`glob` 的修正过程（一并记录，因为第一版是错的）**：最初用了全局 `overrides.glob = 10.5.0`，
结果把 `react-dev-utils` 的嵌套 `glob` 从 **7.2.3 跨大版本拉到 10.5.0** ——
这正是"无关的大版本升级"。已改为只作用于 `@nestjs/cli`，`react-dev-utils` 的 `glob@7.2.3`
回到未变状态（`14-verify-after-glob-scoped.txt`）。

---

## 2. 未修复 —— 明确记录，不隐藏

### R-1 `tmp@0.0.33`（HIGH：GHSA-ph9p-34f9-6g65，路径穿越，`<0.2.6`）

| 项 | 内容 |
|---|---|
| **package** | `tmp` |
| **CVE/公告** | GHSA-ph9p-34f9-6g65（HIGH，`<0.2.6`）+ GHSA-52f5-9888-hmc6（low，`<=0.2.3`） |
| **受影响路径** | `@nestjs/cli@10.4.9` → `inquirer` → `external-editor@3.1.0` → `tmp@0.0.33`。`external-editor` 把构造参数 `fileOptions` 传给 `tmpNameSync()`（`main/index.js:131`） |
| **为什么没升级** | 修复版为 `tmp@0.2.6+`（最新 0.2.7）。`external-editor` **全部 16 个已发布版本**都声明 `tmp@^0.0.33`；`^0.0.33` 在该包自己的 **major=0** 语义下只允许 `0.0.x` 补丁。升到 0.2.7 = **强制跨 major + 超出唯一消费者的声明范围**，属于被明确禁止的动作。已核实不存在任何同 major 的安全修复版本。 |
| **缓解措施** | ① 该链**不在生产树**（`npm ls --omit=dev` 实测 `tmp@` 命中 0 行），Docker 镜像以 `npm ci --omit=dev` 安装 → **生产镜像不含 tmp**；② 触发需要调用方把不可信输入送入 `prefix`/`postfix`，而 `external-editor` 的 `fileOptions` 来自 CLI 调用方自身，本地开发者已具备同等文件写权限；③ 该包仅服务于 `@nestjs/cli` 的交互式编辑器启动，构建/CI 非交互环境不会走到。 |
| **残余风险** | 接受（dev-only，无可用的安全修复版本）。**若将来 `external-editor` 放宽 `tmp` 范围，应立即跟进。** |

### R-2 `@opentelemetry/sdk-node@0.208.0`（HIGH：GHSA-q7rr-3cgh-j5r3，`<0.217.0`）

| 项 | 内容 |
|---|---|
| **package** | `@opentelemetry/sdk-node`、`@opentelemetry/exporter-prometheus` |
| **CVE/公告** | GHSA-q7rr-3cgh-j5r3（HIGH）—— Prometheus exporter 因畸形 HTTP 请求导致进程崩溃 |
| **受影响路径** | `@lark-apaas/observable@1.0.6`（`dependencies: sdk-node@^0.208.0`）→ `NodeSDK` |
| **可达性判定：不可达** | 读取平台实际初始化代码（`node_modules/@lark-apaas/observable/dist/index.js:9092-9113`）：`new NodeSDK({ resource, logRecordProcessor, spanProcessor })` —— **仅**这三个参数，两者都是它自己的 `CustomExporter`/`BatchSpanProcessor`。全树检索 `PrometheusExporter` / `exporter-prometheus`：**0 处引用**。公告要求**启动一个 Prometheus 导出端点**并接收畸形请求；本应用从不启动该监听器，因此触发条件不成立。 |
| **为什么没升级** | `0.208.x` 线**只有一个版本**（0.208.0），修复首次出现在 **0.217.0**（2026-05-06，比 0.208.0 晚 7 个月，跨 9 个 0.x minor）。`@opentelemetry/*` 在 0.x 阶段把每个 minor 当 breaking 处理，且 `@lark-apaas/observable` 自身也锁在 `^0.208.0`。跨 9 个 0.x minor 升级一个**不可达**公告所涉的模块 = 明确的无关大版本升级。 |
| **缓解措施** | 不在请求路径上、不启动该导出端点（已用代码取证）。 |
| **残余风险** | 接受（不可达 + 无同线修复版）。 |

### R-3 `@opentelemetry/propagator-jaeger@2.2.0`（HIGH：GHSA-45rx-2jwx-cxfr，`<2.9.0`）

| 项 | 内容 |
|---|---|
| **package** | `@opentelemetry/propagator-jaeger` |
| **公告** | GHSA-45rx-2jwx-cxfr（HIGH）—— `JaegerPropagator` 因畸形 header 抛未捕获异常导致 DoS |
| **可达性判定：不可达** | 全树检索 `propagator-jaeger` / `JaegerPropagator`：**0 处引用**。它只作为 `sdk-node` 的依赖被安装；`NodeSDK` 构造时未传入 `textMapPropagator`，而平台自己那套 trace 上下文由 `CustomTraceExporter` + 自定义 header 格式处理（`observable/index.js` 的 `CUSTOM_FORMAT_REGEX`）。没有实例化的 propagator 就不会解析任何 header。 |
| **为什么没升级** | 同 R-2：`@lark-apaas/observable` 锁 `^0.208.0`，而该 propagator 与 sdk-node 版本线绑定；单独强推 `2.9.0` 会与 sdk-node 0.208.0 的内部 API 期望错配，且属无关升级。 |
| **缓解措施** | 未实例化，不在请求路径上。 |
| **残余风险** | 接受（不可达）。 |

---

## 3. 修改清单（最小必要）

`package.json` → `overrides` 新增 6 条（其中 1 条为作用域形式）：

```json
"overrides": {
  "multer": "2.4.0",
  "js-yaml": "4.3.2",
  "picomatch": "4.0.7",
  "lodash": "4.18.1",
  "drizzle-orm": "0.45.3",
  "@nestjs/cli": { "glob": "10.5.0" }
}
```

外加：`dependencies.drizzle-orm` 0.44.6 → 0.45.3；`devDependencies.lodash` ^4.17.21 → 4.18.1
（后者是 npm 的 EOVERRIDE 规则要求，override 与直接依赖必须一致）。

**没有**修改：审计门禁逻辑、`predeploy-check.sh` 的任何阈值、任何 `catch {}` 吞错路径。

## 4. lockfile diff

| 类别 | 内容 |
|---|---|
| 版本变化（6） | `drizzle-orm` 0.44.6→0.45.3 · `multer` 2.0.2→2.4.0 · `picomatch` 4.0.1→4.0.7 · `@nestjs/cli/node_modules/glob` 10.4.5→10.5.0 · `glob/node_modules/brace-expansion` 5.0.9→5.0.12 · `path-scurry/node_modules/lru-cache` 11.5.2→11.5.3 |
| 移除（13） | 4 个已修复的嵌套副本（`@nestjs/swagger/{lodash,js-yaml}`、`@nestjs/config/lodash`、3×嵌套 `picomatch@2.3.2`）等 |
| 新增（2） | `lru-cache@10.4.3`、`react-dev-utils/…/glob@7.2.3`（后者是从"被误升"恢复原状） |
| 哈希 | before `cd99cf97…` → after `3c972eb5…`（`00-lockfile-*.sha256`） |

`brace-expansion` / `lru-cache` 两条是 **glob override 的附带解析**（`glob → minimatch → brace-expansion`、
`glob → path-scurry → lru-cache`），均为 **patch 级、无安全公告**（已查询确认）。

`npm ci --omit=dev --dry-run` → **rc=0**（lockfile 与 package.json 同步，Docker 构建前置条件成立）。

## 5. 每次升级后的完整验证

每批次都跑了：`npm test` · `typecheck server` · `typecheck client` · `npm run build` ·
全部 HTTP 安全套件（`scripts/verify-all.sh`）· predeploy。

四批次结果**完全一致，全绿**：

```
npm test              230/230
typecheck server      PASS
typecheck client      PASS
npm run build         PASS
api-contracts         matched
authz-http            74/74
hardening             10/10
mfa                   55/55
security-headers      20/20
files-http            73/73
naming-http           49/49
```

## 6. 顺带发现并修复的环境缺陷（非依赖问题，但会假性阻塞构建）

本机 `npm install` 会按 **linux/x64 专用**的 lockfile 剪掉 macOS/arm64 原生绑定
（`@swc/core-darwin-arm64`、`@rolldown/binding-darwin-arm64`、`lightningcss-darwin-arm64`、
`@tailwindcss/oxide-darwin-arm64`），导致 `npm run build` 报
`Failed to load "@swc/cli" and/or "@swc/core"`。

这是 lockfile 为发布目标平台生成、开发机是另一平台的**必然结果**
（`DEPLOYMENT_PRODUCTION.md` §6/§7.2 已记录同一现象，并明确要求**不要**为了本机重建 lockfile）。

新增 `scripts/repair-local-native-bindings.sh`（含 `--check` 模式供 CI 用）修复该问题，
**不修改 package.json / package-lock.json**。

## 7. 新增的防回归闸门

`scripts/ci-check-drizzle-api.mjs` —— drizzle-orm 是**精确锁定**的 peer 依赖
（两个平台包都声明 `"drizzle-orm": "0.44.6"`，无 caret），而修复在 0.45.2，
所以本次升级是一个**被迫的 peer 偏差**。该脚本验证平台 monkey patch 依赖的内部符号
（`drizzle-orm/postgres-js` 的 `PostgresJsPreparedQuery.prototype.execute`）在升级后仍然存在
—— 该符号缺失会让 `@lark-apaas/nestjs-datapaas` 在启动时直接抛错。
升级前后均运行，均 PASS。

**已知局限（不掩饰）**：这是**符号存在性**检查，不是行为等价性检查。
`PostgresJsPreparedQuery` 存在但语义变化的情况本脚本发现不了 —— 那只能由平台上真实请求路径验证。
