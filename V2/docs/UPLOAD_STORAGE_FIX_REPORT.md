# V2「上传图片失败」故障 —— 根因定位与修复报告

> 范围：只动 V2 的**演练配置**与**门禁**，没有改任何业务代码、没有改 UI。
> V1 源码零改动；未触碰 Zeabur、正式库、正式域名、生产 R2。
> 状态词只用 `PASS / FAIL / UNVERIFIED / BLOCKED / NOT RUN`。

## 0. 结论

```
根因定位            : PASS（容器内 ENOTFOUND，同一端点上做了前后对照）
根因修复            : PASS（docker-compose.rehearsal.yml：容器内解析 + 信任自签证书）
服务端→存储 连通性   : PASS（/api/health/storage：reachable=true）
真浏览器 UI 上传     : PASS（8/8 项，图片登记成功、可预览）
部署级浏览器门禁     : PASS（9/9，含新增 ③ter）
部署巡检 verify.mjs  : PASS（12/12，含新增"服务端可访问对象存储"）
全量门禁            : PASS（build / typecheck / lint / unit / integration，见 §6）
```

**一句话根因**：上传是三步 —— ① 服务端**只做签名**发一个 presigned URL（不联网，成功）；
② 浏览器 PUT 字节到那个地址（浏览器能解析 `s3.localhost`，成功，**字节其实已经写进存储了**）；
③ 服务端**自己**去对象存储核对对象（`HeadObject`）→ 这一步要用 `STORAGE_ENDPOINT`，
也就是 `https://s3.localhost:8443`，而 **app 容器里的 DNS 解析不了 `s3.localhost`**
（它不是 compose 网络里的名字）→ 第 ③ 步失败 → 接口返回 `503 STORAGE_UNAVAILABLE`
→ 资源的 `fileCount` 永远是 0。浏览器上就是"上传图片失败"。

> 这类故障最容易误判：前端、代理、存储、签名**全都是好的**，字节也确实进了对象存储，
> 只有"服务端回来后自己核对"这一步够不着。所以第 ①② 步全绿并不能说明上传能用。

## 1. 复现（完全按真实链路，逐步留证据）

用授权管理员账号在演练环境跑同一条链路（① 申请 → ② PUT → ③ 登记）：

| 步骤 | 修复前 | 修复后 |
|---|---|---|
| ① `POST /api/resources/:id/files/upload-url` | **201**（签名只算不联网，所以这一步永远是好的） | 201 |
| ② `PUT <presigned>` 到 `https://s3.localhost:8443/…` | **200**（浏览器/宿主机侧能解析，字节真写进存储） | 200 |
| ③ `POST /api/resources/:id/files/register` | **503 `STORAGE_UNAVAILABLE`** ← **故障点** | **201**（返回文件名/大小/sha256/可预览） |
| 资源文件列表 | `{"items":[]}`（0 个文件） | 1 个文件 |

## 2. 根因证据

### 2.1 容器里解析不了对象存储的域名

```
$ docker compose … exec app node -e "require('dns').lookup('s3.localhost',…)"
修复前:  DNS: ENOTFOUND          ← 根因
修复后:  DNS: 192.168.65.254     （宿主网关 → 宿主机发布的 8443 → 代理 → SeaweedFS）
```

### 2.2 在**同一个端点**上做前后对照（最直接的证据）

`/api/health/storage` 就是第 ③ 步那次 `HeadBucket`（服务端发起、只读）：

| 配置 | 该端点的返回 |
|---|---|
| 修复前（去掉那行 `extra_hosts`） | `{"configured":true,"reachable":false,"detail":"无法访问对象存储：Error: getaddrinfo ENOTFOUND s3.localhost"}` |
| 修复后 | `{"configured":true,"reachable":true,"detail":"对象存储可访问"}` |

这正是用户看到"上传图片失败"时服务端的真实状态。

### 2.3 排除项（逐条实测，都不是原因）

| 假设 | 结论 |
|---|---|
| 前端/UI 坏了 | 不是：上传按钮、对话框、文件选择、提交、进度都正常（§4 浏览器用例 8/8） |
| 存储坏了或写入被拒 | 不是：第 ② 步 PUT 返回 200，对象真的落进了 SeaweedFS |
| 预签名 URL/SigV4 签名错 | 不是：签名与 `host:port` 一致，PUT 200（若签名错会是 403） |
| 代理路由错 | 不是：`/qls-v2-files/...` 经代理到 SeaweedFS 正常（修复前后都通） |
| CSP 挡住了直传 | 不是：CSP 的 `connect-src` 允许 `https://s3.localhost:8443` |
| 权限/目录不允许 | 不是：目录 `allow_files=true`、管理员可用；同样的请求修复后 201 |
| 磁盘满/桶不存在 | 不是：桶存在且第 ② 步写入成功 |

## 3. 修改的文件（只动演练配置与门禁）

| 文件 | 改动 | 为什么 |
|---|---|---|
| `docker-compose.rehearsal.yml` | app 增加 `extra_hosts: ['s3.localhost:host-gateway']`；挂载演练自签证书并设 `NODE_EXTRA_CA_CERTS` | **根因修复**：让容器内也能解析对象存储的**公网名字**（Host 头不变 → SigV4 照旧成立），并**只增加信任**、不关闭 TLS 校验 |
| `deploy/verify.mjs` | 新增"服务端可访问对象存储（上传登记的前提）"检查；新增 `⏭ 未验证` 状态（没有凭据时**不假装通过**） | 一条命令就能提前发现这类"服务端够不着存储"的故障 |
| `tests/production/production-browser.test.mjs` | 新增 `③ter 服务端能自己访问对象存储`（只读，用已登录会话探 `/api/health/storage`） | 部署级门禁覆盖"上传第三步的前提" |

**没有**：改业务逻辑、改 UI、改存储实现、放宽任何测试断言、关闭任何安全措施。

**为什么必须连着名字+端口访问**：预签名 URL 的 SigV4 签名覆盖 `host:port`。
直连 SeaweedFS（`host.docker.internal:18443`）或改端口都会 `403 SignatureDoesNotMatch` ——
所以修的是"容器内如何解析这个名字"，不是"换成另一个地址"。

**证书**：`NODE_EXTRA_CA_CERTS=/etc/v2-tls/fullchain.pem` 是把演练的自签证书**加入信任**，
**不是** `NODE_TLS_REJECT_UNAUTHORIZED=0`（那等于关掉校验，不在选项里）。

## 4. 修复后的真浏览器 UI 验收（演练环境）

走用户那条路：登录 → 目录页 → 上传按钮 → 选一张真 PNG → 提交 → 看结果。
浏览器：本机 Chrome（headless / CDP，`--ignore-certificate-errors` 仅用于自签证书）。

| 项 | 结果 |
|---|---|
| 目录页有"上传"入口（`data-testid=directory-upload`） | ✓ |
| 文件选择器接受 PNG | ✓ |
| 上传成功（对话框完成 / 跳详情页） | ✓ `/resources/97ff8a90-…` |
| 资源下登记了文件（`fileCount>0`） | ✓ `probe-upload.png 78 B image/png` + sha256 |
| 预览地址可取（服务端能读出图片） | ✓ `HTTP 200` |
| 上传过程中控制台/网络 | ✓ 无未处理异常、无失败请求 |
| 截图 | `.devdata/login-render-evidence/upload-after-fix.png`（资源详情页显示"文件 共 1 个"） |

**8/8 项通过。** 验证产生的探针资源已用 `POST /api/resources/:id/purge` **硬删除**
（返回 `removedFiles:1, removedObjects:1` —— 连对象存储里的字节也一并清掉了，没有留下孤儿对象）。

## 5. 门禁（新增/更新后会拦什么）

- `deploy/verify.mjs`：`✅ 服务端可访问对象存储（上传登记的前提）  provider=s3 configured=true reachable=true`；
  不带管理员凭据时显示 `⏭ 未验证 …`，汇总写"另有 1 项未验证" —— **不通过也不判失败，绝不假装通过**。
- `tests/production/production-browser.test.mjs`：`③ter` 通过与其余 8 项一起给出 **9/9 PASS**。

## 6. 全量门禁（实际命令、退出码、结果）

工作目录 `V2/`，`V2_TEST_DATABASE_URL=postgresql://…@127.0.0.1:55432/qls_v2_test`：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run build` | 0 | 通过（含前端产物自检闸门） |
| `npm run typecheck` | 0 | 通过 |
| `npm run lint` | 0 | 0 error |
| `npm run test:unit` | 0 | **206 / 206** |
| `npm run test:integration` | 0 | **582 / 582**（含真实 S3 上传/预览/下载链路） |
| `node --test tests/production/production-browser.test.mjs`（对演练地址） | 0 | **9 / 9** |
| `node deploy/verify.mjs --base https://v2.localhost:8443 …` | 0 | **12 / 12** |

## 7. 数据处置与遗留

| 项 | 处置 |
|---|---|
| 复现/验收产生的 3 条探针资源 | **已硬删除**（purge），对象存储里的字节也一并删除；演练库回到 349 条 |
| 演练库里一条标题为`测试`的资源（`b21d3fb5-…`，DRAFT，0 文件，创建于 2026-10-09 01:20） | **我没有动它** —— 它不是本次验证产生的，看起来是用户自己的那次尝试：请求建资源成功、上传文件失败，所以留下一条没有文件的草稿。现在可以直接在它的详情页用「+ 添加文件」补传，或删掉重来 |
| 演练库当前计数 | `users=24 / directories=69 / resources=350（349 + 上面那条）/ resource_files=2 / resource_reviews=2 / audit_logs=741` |
| 生产（Zeabur + R2） | 不受影响：R2 的 endpoint 是公网可解析且证书有效，**不涉及本故障**。正式切换仍 **BLOCKED** |
| 是否需要在代码里分开"服务端 endpoint"与"公网 endpoint" | **未做，记为建议**：当前实现两个用途共用 `STORAGE_ENDPOINT`；若将来某套部署的存储域名也只在浏览器侧可解析，会重现同一故障。真要做是新增一个可选配置（服务端调用用内部地址、签名用公网地址），属于产品改动，本轮不做 |

---

# 附：第二层原因 —— 浏览器没有信任**存储 origin** 的证书（2026-10-09 追加）

修完"服务端够不着存储"之后，用户在真实浏览器里仍然失败，界面报
**「网络中断，上传没有完成。请检查网络后重试。」** —— 这是**另一条**原因，与 §1 那条无关。

## 8.1 证据（不需要登录的跨域实验）

从应用页面对存储 origin 发一次真实 PUT，同一套环境、只差"是否信任过该 origin 的证书"：

| 状态 | 结果 |
|---|---|
| 浏览器**未信任** `https://s3.localhost:8443` 的证书 | `fetch` 抛错 —— **`Failed to fetch`**（前端就渲染成"网络中断"） |
| 在该 origin 上点过一次"继续前往"之后 | **HTTP 403 `AccessDenied`** —— 私有桶对未签名请求的正常拒绝，说明浏览器**真的连上了** |

另外实测：演练证书的 SAN **已经同时包含** `v2.localhost` 与 `s3.localhost`
（`DNS:v2.localhost, DNS:s3.localhost, IP:127.0.0.1`），两个 SNI 发的是同一张证书 ——
所以**不是**"证书名字不匹配"，而是**这张自签证书没有被浏览器信任**。

## 8.2 为什么用户会撞上、而自动化验收没撞上

- 用户在应用 origin（`v2.localhost`）上点过"继续前往"，所以页面能打开；
  但跨域 PUT 的目标是**另一个 origin**（`s3.localhost`），证书要**各自**信任。
  跨域子请求被 TLS 拦下时**不会弹警告页**，只会让 `fetch` 抛错 → 界面显示"网络中断"。
- 本项目的浏览器验收此前统一带 `--ignore-certificate-errors`（自签证书的演练惯例），
  那个参数会**同时**放过"证书不受信任"的情况 —— 于是这条故障被掩盖了。
  **这是验证盲区，如实记录。** 现已补上门禁项 `③quater`（见下）。

## 8.3 立即可用的一次性办法（已实测有效）

在浏览器里**单独访问一次**存储地址并接受证书：

```
https://s3.localhost:8443/qls-v2-files
→ 出现"您的连接不是私密连接" → 点「高级」→「继续前往（不安全）」
```

之后上传即可正常完成（该 origin 的例外会记在这个浏览器 profile 里）。
缺点：换浏览器/清空 profile/换机器都要再来一次。

## 8.4 新增门禁

`tests/production/production-browser.test.mjs` 增加 **③quater 浏览器能连上对象存储 origin**
（`HEAD` + `mode:'no-cors'` 探针，只读、不写入任何对象；未设 `PRODUCTION_STORAGE_ORIGIN` 时**跳过**并标注"未验证"）。
局限已在用例注释里写明：带 `PRODUCTION_INSECURE_TLS=1` 跑时它能发现 DNS/代理/CORS 类问题，
**只有不带该参数运行时**才能证明"用户的普通浏览器也连得上"。

## 8.5 生产（Zeabur + R2）不受影响

R2 的 endpoint 是公网域名、证书由受信任 CA 签发，**不存在**这一层问题。
这是**本地演练环境自签证书**的特有现象。

## 8.6 待决（需要业主选择）

| 选项 | 做法 | 代价 |
|---|---|---|
| A（已可用） | 每个浏览器对存储 origin 接受一次证书警告 | 换 profile/机器要重做；地址栏仍显示"不安全" |
| B（推荐） | 生成一个本地开发 CA，用它签发覆盖两个 host 的证书；把 CA 加入 macOS 信任（需业主在自己的终端执行一条 `sudo security add-trusted-cert …`，我不索取管理员口令） | 改动本机信任库（安全相关，须业主同意）；之后演练环境不再有证书警告 |
| C | 演练里把对象存储改成**与应用同源**（nginx 路径前缀，SigV4 路径保持不变） | 用户零操作，但演练拓扑与生产不一致（生产是跨域 R2），且要动共享的 nginx 模板 |
