# V2 文件存储（阶段 6）

> 这份文档回答一个问题：**文件到底存在哪、怎么进去的、谁能在什么时候拿到它。**
> 里面每一条"为什么这么定"都来自实测，不是设计偏好。

## 1. 一条上传到底发生了什么

```
教师点「上传资源」（目录页，directoryId 已经确定）
        │
        ├─ ① POST /api/resources                     建草稿资源 → 拿到 resourceId
        │
        ├─ ② 浏览器算 sha256（SubtleCrypto）
        │
        ├─ ③ POST /api/resources/:id/files/upload-url
        │      服务端：鉴权（目录 + 所有权 + 资源状态）
        │              校验（扩展名 + MIME + 大小）
        │              生成 key：resources/{resourceId}/{uuid}-{safeName}
        │              预签名 PUT —— 把 size 与 sha256 写进**签名**
        │              写 upload_tickets（票据）
        │      ↓ 返回 { uploadId, uploadUrl, headers }
        │
        ├─ ④ PUT <uploadUrl>  ← 浏览器**直连对象存储**，字节不经过 VPS
        │      存储层自己校验：字节与签名里的 sha256 / size 不一致 → 400，对象不落地
        │
        └─ ⑤ POST /api/resources/:id/files/register  { uploadId }
               服务端：HEAD 对象 → 大小一致？
                       读前 64 字节 → magic bytes 与扩展名、MIME 三者相符？
                       事务内：写 resource_files + 作废票据
```

**为什么 sha256 必须进签名**（而不是"传完再比一下"）：
签名是服务端生成的，客户端改不了。于是"上传的字节不是声明的那个文件"会在
**存储层**被拒绝，坏数据根本没有机会进入桶里 —— 比事后回读校验强一个量级，
而且不需要把每份课件都从对象存储回流一次 VPS。

## 2. 两个驱动，同等强度

| | `local`（开发） | `s3`（生产：R2 / AWS S3 / MinIO） |
|---|---|---|
| 上传地址 | `/api/storage/local?key=…&token=…`（HMAC 令牌里带 size/sha256） | 预签名 PUT，`x-amz-checksum-sha256` 作为**已签名头** |
| 完整性由谁强制 | 数据面重算 sha256，不符就 **400 且不落盘** | 对象存储自己校验 checksum，不符就 **400 且不落盘** |
| 登记时校验 | 读回对象算 sha256（同一个进程同一块盘，不花流量） | HEAD 大小 + 驱动能给出哈希时再比一次，否则如实标注 `upload-integrity-header` |
| 下载/预览 | HMAC 令牌（含处置方式、文件名、Content-Type） | 预签名 GET（`ResponseContentDisposition` 等参与签名） |

两个驱动**行为一致**是刻意的：如果本地驱动只是"把字节写进去"，
所有完整性测试就只能在 S3 上跑，而本地开发环境反而漏掉这类 bug。
集成测试在两种驱动上跑**同一组断言**。

## 3. 三个必须记住的坑（都是实测撞出来的）

### ① 新版 AWS SDK 的默认校验和会让预签名 URL 直接失败

SDK（3.729+）默认给每个请求注入 `x-amz-checksum-crc32`。预签名时 body 还不知道，
于是 URL 里被写进**空 body 的 CRC32**；真上传时服务端算出真实 CRC32，两者不符：

```
400 BadDigest  The Content-Md5 you specified did not match what we received.
```

**必须**在客户端配置里关掉：

```ts
new S3Client({ ..., requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' })
```

### ② checksum 不能被"提升"成 query 参数

SDK 默认会把 `x-amz-checksum-*` 提升到查询串。部分 S3 兼容实现
（实测 SeaweedFS 4.48）在验签时对查询串里的 checksum 处理不一致，结果是
`SignatureDoesNotMatch`。用 `unhoistableHeaders` 把它强制留在签名头里：

```ts
getSignedUrl(client, command, {
  signableHeaders: new Set(['content-type', 'x-amz-checksum-sha256']),
  unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
})
```

### ③ 响应元数据不能放在**未签名**的查询参数里

本地驱动第一版把 `disposition` / `name` / `type` 放在 URL 查询参数里，而签名只覆盖
`(op, key, exp)`。于是谁都能在下载地址后面追加 `&type=text/html` 改掉响应的
`Content-Type`，或者用 `&name=evil.exe` 改掉下载文件名（`Content-Disposition` 注入）。
现在这三个值**只存在于 HMAC 令牌里**，URL 上只剩 `key` 与 `token`。

## 4. 文件策略（允许什么、怎么判）

单一真相：`shared/file-policy.ts`，前后端读同一份常量。

* 允许：`PDF / PNG / JPG / JPEG / TXT / DOCX / XLSX / PPTX / ZIP`
* 单个文件上限：**50 MB**（前端用它做即时提示，后端用它做最终拒绝 —— 不会出现
  "前端 50MB、后端 100MB，用户传到一半才失败"）
* 判定是**三者综合**：扩展名 + MIME + magic bytes

| 情况 | 结果 |
|---|---|
| `a.exe` / `a.html` / `a.js` / `a.php` | 拒绝（`FILE_NAME_UNSAFE`） |
| `a.csv` / `a.md`（不在白名单也不危险） | 拒绝（`FILE_TYPE_NOT_ALLOWED`） |
| `test.pdf.exe` / `test.exe.pdf` / `x.php.pdf` | 拒绝（双扩展名） |
| `../../etc/passwd`、含 `/` `\` NUL 换行 | 拒绝（路径穿越 / 控制字符） |
| 声明 `text/html` 的 `.pdf` | 拒绝（MIME 与扩展名不符） |
| 一个 ELF 改名成 `.pdf` | 申请能过（看不到字节），**登记时被 magic bytes 拒绝** |
| 内容是 HTML 的 `.txt` | **允许**：以 `text/plain` + `nosniff` 返回，只当文本显示 |

对象 key 固定形状 `resources/{resourceId}/{uuid}-{safeName}`：
用户文件名**不参与目录结构**（`../` 无从穿越），uuid 前缀保证同名文件不会互相覆盖。

## 5. 预览与下载

| 类型 | 行为 |
|---|---|
| PDF | 浏览器自带阅读器（`<iframe>`），不引入 PDF SDK |
| PNG / JPG | `<img>` |
| TXT | 取回文本自己渲染成文本节点（**不塞进 iframe**，所以 HTML 内容不会执行） |
| DOCX / XLSX / PPTX / ZIP | **只有「下载」**，并显示「此文件类型暂不支持在线预览，请下载查看。」 |

不渲染"点了会失败"的预览按钮 —— 业主的规则是"不能点按钮没有反应"。

* 地址是**短期签名地址**（默认 300 秒），过期 / 改一个字符 / 换 key 全部 403。
* 响应头由**服务端**决定：`Content-Type` 来自数据库、`disposition` 来自签名、永远 `nosniff`。
* 私有资源一律 `Cache-Control: private, no-store, max-age=0`。

## 6. 部署清单

```bash
# 1) 建桶（R2 / S3 / MinIO 任选），拿到 endpoint / bucket / access key / secret
# 2) 配置环境变量（见 .env.example），生产必须 STORAGE_PROVIDER=s3
# 3) 让 bucket 接受来自正式域名的跨域 PUT（绝不要用 *）
V2_PUBLIC_ORIGIN=https://v2.example.com npm run storage:cors
# 4) 自检：配置齐不齐、桶连不连得上、CORS 是不是通配符
npm run storage:check
```

`npm run storage:check` 输出的是**结论**（configured / reachable / CORS），
不会打印 bucket、endpoint 或任何密钥。

### 孤儿对象

真实会发生的事：PUT 成功了，但登记失败（哈希不符 / 票据过期 / 用户关掉页面）。
对象就在桶里而数据库不知道 —— 这是"孤儿"。

本阶段按业主要求**不引入任务系统**，只用：

```bash
npm run storage:cleanup                 # 处理登记失败留下的标记（storage_orphans）
npm run storage:cleanup -- --sweep      # 顺便扫桶：没有数据库记录且超过 24 小时的对象
npm run storage:cleanup -- --dry-run    # 只报告，不删
```

扫桶时**拿不到对象时间戳就不删**：宁可留一个孤儿，也不要删掉"刚传上来还没登记"的文件。

## 7. 测试怎么证明这些

| 套件 | 证明什么 |
|---|---|
| `tests/unit/file-policy.test.mjs` | 允许清单、双扩展名、路径穿越、三者综合判定、大小上限 |
| `tests/unit/storage-rules.test.mjs` | key 形状、令牌签了哪些字段、Content-Disposition 注入、CORS 不许通配符 |
| `tests/integration/upload.integration.test.mjs` | 四步链路、存储层拒绝坏字节、票据只能一次、magic 验真、多文件、状态锁、删除顺序、孤儿清理 |
| `tests/integration/download-preview.integration.test.mjs` | 各类型的 viewer、响应头由服务端定、过期 / 篡改 / 换 key、审计 |
| `tests/integration/file.integration.test.mjs` | 文件访问控制（目录授权 + 所有权 + 草稿不可见） |
| `tests/integration/storage-s3.integration.test.mjs` | **真 S3 后端**：PUT/HEAD/GET、SigV4 六种情况、真桶 CORS 预检、health 不泄凭据 |
| `tests/integration/browser.stage6.test.mjs` | 真浏览器走完整条路：上传 → 刷新 → 找到 → 预览 → 下载并比对 SHA256 |

真 S3 后端是 SeaweedFS（`npm run devtools:storage` 取回，放在已 gitignore 的 `.devtools/`）。
**MinIO 的开源服务端已归档、官方不再分发**，所以用它。

> 为什么非要真后端：预签名 URL 的正确性只能由**一个独立实现的 S3 服务**来证明。
> mock 通常不验签，"签名算错了"在 mock 里永远是绿的，上线第一个上传才 403 ——
> 而那时排查方向会被引到前端去。
