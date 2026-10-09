# V2 Stage 12：本机 Docker 完整演练报告

> 业主的顺序要求：**先本机 Docker 完整演练 → 再上 Zeabur**。
> 这份报告是"本机这一段"的证据：**每一个数字都是本机真实跑出来的**，
> 没有一项是"读配置推断"。
>
> 演练用的**不是模拟数据**：数据来自 `2026-10-08 11:18:23（北京时间）` 从
> **在线生产 V1（Zeabur）** 导出的快照
> （`prod-export-20261008_031823.ndjson`，sha256 `b1a2e0e8…`，见
> `docs/V1_PRODUCTION_SOURCE_FREEZE.md`）。

---

## 1. 拓扑（演练 = 生产的形状）

```
Internet → HTTPS → Nginx（TLS / 安全头 / 429 限流 / XFF 覆盖）→ V2 App（单实例）
                                                              ├→ PostgreSQL 16
                                                              └→ S3 兼容对象存储
```

| 生产 | 演练（本机） |
|---|---|
| Zeabur 边缘 TLS + 正式域名 | Nginx 容器 + **本地开发 CA 签发**的证书（`v2.localhost:8443`，SAN 含 `s3.localhost`）；CA 由 `deploy/rehearsal-tls.mjs` 生成、由业主加入 macOS 信任库 |
| Zeabur Postgres | compose 里的 `postgres:16-alpine` |
| Cloudflare R2 | 宿主机上的 SeaweedFS S3 网关（项目测试一直在用的那个） |
| — | `deploy/rehearsal-*.mjs` 两个小工具只在演练里用 |

> 演练里存储**在容器之外**，这一点反而与生产一致（R2 也是外部服务）。

## 2. 逐项结果

| 项 | 结果 | 证据 |
|---|---|---|
| `docker build` | ✅ | 多阶段：deps → build（容器内真的跑了 `nest build` + `vite build` + `check-dist`）→ prod-deps → runtime |
| non-root | ✅ | `docker run … id` → `uid=10001(v2) gid=10001(v2)` |
| production dependencies | ✅ | 运行镜像里 `vitest/eslint/typescript/@nestjs/cli` 数量 = **0** |
| 无 dev secret | ✅ | 镜像里没有 `V2_ALLOW_DEV_SECRETS`；缺密钥时进程**启动失败**（config.ts 无默认密钥） |
| 无本地测试数据 | ✅ | 镜像里没有 `tests/`、`.migration/`（含生产快照）、`credentials/`、`.devtools/` |
| healthcheck | ✅ | 镜像自带，指向 `/api/health/ready`（真的查库） |
| `docker compose config` | ✅ | exit 0 |
| `docker compose build` | ✅ | `qls-v2-app:2.0.0-rehearsal` |
| `docker compose up -d` + `ps` | ✅ | app / db / proxy **全部 healthy** |
| 从干净状态开始（§4） | ✅ | `down -v`（删卷）→ `up -d` → 迁移 → 导入，全程无残留 |
| HTTP → HTTPS 跳转 | ✅ | 301 + `Location: https://…` |
| HTTPS + 证书 | ✅ | `--cacert deploy/tls/fullchain.pem`，HTTP/2 200 |
| 六个安全响应头 | ✅ | HSTS / XCTO / Referrer-Policy / X-Frame-Options / CSP / Permissions-Policy |
| 没有 `x-powered-by` | ✅ | 应用侧 `disable('x-powered-by')`，代理侧 `server_tokens off` |
| `/api/health` | ✅ | 200 |
| `/api/health/ready` | ✅ | 200（真的连库） |
| 静态资源 | ✅ | 首页 200；JS 的 content-type 是 `javascript`、CSS 是 `css`（不是 text/html 冒充） |
| **登录限流 429（§14）** | ✅ | 连续错口令：`401,401,401,401,429,429,…`，429 带 `Retry-After: 60` 与 JSON body |
| **XFF 覆盖（§11）** | ✅ | 请求里塞 `X-Forwarded-For: 1.2.3.4` / `X-Real-IP: 5.6.7.8`，审计里出现伪造 IP 的**行数 = 0** |
| Cookie（§12） | ✅ | `v2_session`：**HttpOnly + Secure + SameSite=Lax**（浏览器里实测） |
| 会话不进 localStorage | ✅ | `localStorage`/`sessionStorage` 均为空 |
| 生产数据迁移 | ✅ | **349 资源 / 24 账号 / 69 目录 / 2 文件 / 2 审核 / 621→650 审计**（与生产快照一致） |
| 文件真的进了对象存储 | ✅ | 桶里 2 个对象（94 字节 / image/png），与 `resource_files.storage_key` **逐条对得上**（不匹配 0 条） |
| **生产超管用原 V1 口令登录** | ✅ | `TsinglanAdmin` → `POST /api/auth/login` **201**（口令兼容迁移有效） |
| 重启 app（§24） | ✅ | 数据不变（24/69/349/2/646/2），`/api/health/ready` 200 |
| 重启 db（§24） | ✅ | 同上 |
| 备份 / 还原（§22） | ✅ | 容器内 `pg_dump -Fc` → `pg_restore` 到 `restore_test`；六张核心表行数**逐一相同** |
| `deploy/verify.mjs` | ✅ | **11/11 通过，exit 0**（失败会 exit 1） |

### 2.1 真实浏览器（演练栈，HTTPS）

`tests/production/production-browser.test.mjs`（业主 §28 要求的位置与形态），
对着 `https://v2.localhost:8443` 跑真实 Chrome：**7/7 通过**

| # | 检查 | 结果 |
|---|---|---|
| ① | HTTPS + `isSecureContext` + 不是错误页 | ✅ |
| ② | Cookie 三个标志 + 会话不在 localStorage | ✅ |
| ③ | 静态资源 200 且 MIME 正确 | ✅ |
| ④ | 登录后**一格格点进目录**（路径从接口取，不写死） | ✅ |
| ⑤ | 打开迁移过来的资源（详情页标题 + 目录） | ✅ |
| ⑦ | **真实文件下载**：浏览器经签名地址取回 94 字节 | ✅ |
| ⑧ | 全程 console / 网络 0 错误 | ✅ |

> 这条通道同时就是**上 Zeabur 之后要跑的那条**：只换
> `PRODUCTION_BASE_URL`（正式域名）、去掉 `PRODUCTION_INSECURE_TLS`、
> 换成正式管理员账号即可。

## 3. 演练中真实踩到并修掉的 5 个问题

1. **快照还原脚本的 CASCADE 静默抹数据**：第一版按表循环"TRUNCATE 这张 → INSERT 这张"，
   走到 `teachers` 时 `TRUNCATE … CASCADE` 顺着外键把已经灌好的 `resources` 也清了 ——
   349 条资源被静默抹掉，脚本还报"349 已插入"。**修法**：一次性清空全部基表再插入，
   并保留"逐表与 footer 对照，不一致 exit 4"的判定。
2. **导入脚本用错存储驱动**：`.env.deploy` 里少了 `STORAGE_PROVIDER`，
   导入用了默认的 `local`，文件写到了宿主机的 `.devdata/storage`，
   而库里已经登记好行 —— 应用（S3）永远取不到。**修法**：补上 `STORAGE_PROVIDER=s3`，
   并在报告里写明**生产导入必须在应用容器内执行**（env 不可能走偏）。
3. **`NODE_EXTRA_CA_CERTS` 在脚本里赋值太晚**：TLS 上下文早就建好了，
   表现是所有 https 请求 `fetch failed`。**修法**：`verify.mjs` 检测到 `--cacert`
   时**重新 exec 自己**，把环境变量带上。
4. **`verify.mjs` 一开始打错了库**：在宿主机跑 `migrate status` 用的是宿主机的
   `DATABASE_URL`（开发库），结论毫无意义。**修法**：改为 `docker compose exec app …`
   与 `… exec db psql …`，只打**已部署的**那套。
5. **HTTP 端口用了 10080**：`fetch` 规范的禁用端口列表包含 10080（浏览器同样可能拒绝），
   表现是 http 那条检查永远 `fetch failed`。**修法**：演练改用 10088（生产是 80）。

## 4. 待查项（不假装通过）

1. **目录浏览页与接口的口径不一致**（需要定性）：
   接口 `GET /api/resources?page=1` 说那条迁移过来的资源属于
   `edu/k/chinese/arts/resources`（`directory_id` 也确实指向它），
   但打开 `/directory/edu/k/chinese/arts/resources` 时页面显示"这个目录下还没有资源"，
   而且**连"资源共 N 条"那一段都没渲染**。
   两种可能：浏览页的资源过滤语义与接口的 `directoryPath` 口径不同，
   或者迁移后真的有一条浏览缺陷。证据与复现命令见 §5。
2. **生产 V1 的 commit 仍未知**：`/api/health` 返回 `version: "unknown"`，
   需要业主在 Zeabur 控制台确认。
3. **那 2 条 `test` 资源与它们的文件**：演练里用占位文件跑通了链路；
   正式迁移要决定是"搬真对象（需要 R2 凭据）"还是"先在 V1 清掉这两条 smoke 痕迹"。
4. **迁移不发授权**：24 个账号迁过来了，但 `user_permissions = 0`（设计如此）。
   老师能登录、看不到目录，需要管理员按 `docs/V1_MIGRATION_REPORT.md` 的
   「角色 → 建议授予」清单授权。**这是上线当天必须做的一步。**

## 5. 复现命令（照抄即可）

```bash
cd V2
# 0) 生产快照还原成本地 V1 库（真实 schema：从模板库克隆）
node scripts/load-v1-snapshot.mjs
# 1) 起演练用的外部存储 + V1 桥（两个后台进程）
node deploy/rehearsal-storage.mjs &
node deploy/rehearsal-v1-bridge.mjs &
# 1.5) 演练证书：生成开发 CA 与站点证书（**首次或换机器时一次**）
node deploy/rehearsal-tls.mjs
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$PWD/deploy/tls/ca.pem"
#      ⚠️ 必须做这一步：上传的字节是浏览器**跨域直传**到 s3.localhost 的，
#         那个 origin 的证书要**各自**被信任；不被信任时跨域子请求不弹警告页、
#         只让 fetch 抛错，界面显示成"网络中断"（2026-10-09 实际踩到，见
#         docs/UPLOAD_STORAGE_FIX_REPORT.md §8）
# 2) 构建 + 起栈
docker compose --env-file .env.deploy -f docker-compose.yml -f docker-compose.rehearsal.yml up -d --build
# 3) 迁移 + 导入（导入**在应用容器里**跑）
docker compose --env-file .env.deploy exec -T app node scripts/migrate.mjs up
set -a; . ./.env.deploy; set +a
NODE_EXTRA_CA_CERTS=$PWD/deploy/tls/ca.pem node scripts/import-v1.mjs \
  --source postgresql://…/qls_v1_prod_rehearsal \
  --target "postgresql://qls:$POSTGRES_PASSWORD@127.0.0.1:5433/qls_prod" \
  --v1-storage local:$PWD/.devdata/rehearsal-v1-files --report .migration/rehearsal-import.md
# 4) 自检 + 真实浏览器
node deploy/verify.mjs --base https://v2.localhost:8443 --cacert deploy/tls/ca.pem \
  --http-port 10088 --expected resources=349,users=24,directories=69,resource_files=2
#    ⚠️ 开发 CA 装好之后**不要**再设 PRODUCTION_INSECURE_TLS ——
#       那个参数会跳过证书校验，等于把"用户普通浏览器能不能连通存储"这一层遮住
PRODUCTION_BASE_URL=https://v2.localhost:8443 \
  PRODUCTION_STORAGE_ORIGIN=https://s3.localhost:8443 \
  PRODUCTION_ADMIN_USER=TsinglanAdmin PRODUCTION_ADMIN_PASSWORD=… \
  NODE_EXTRA_CA_CERTS=$PWD/deploy/tls/ca.pem \
  node --test tests/production/production-browser.test.mjs
```

## 6. 下一步（上 Zeabur 前还差的）

| # | 事项 | 为什么还没做 |
|---|---|---|
| 1 | 把 app 服务部署到 Zeabur（同一个 Dockerfile） | 需要 Zeabur 项目访问；Postgres 用平台服务，R2 用 V1 的桶 |
| 2 | 正式域名 + 正式证书下的 HTTPS/Cookie/CSP 复验 | 需要域名接管（业主：用 V1 的域名、把 V1 撤下来） |
| 3 | R2 的真实往返（上传/HEAD/下载/preview + CORS 只允许正式 origin） | 需要 R2 的 endpoint/bucket/AK/SK（现在只在 Zeabur 环境变量里） |
| 4 | `deploy.mjs` / `rollback.mjs` | `verify.mjs` 已完成；deploy/rollback 要在目标环境确定后写，否则是纸上作业 |
| 5 | 390×844 / 375×667 / 412×915 的**生产**移动端 E2E（§29） | 同上：先有正式域名，再跑真机视口 |
| 6 | `npm audit` 的 HIGH/CRITICAL 分析（§33） | 未开始 |
| 7 | `docs/PRODUCTION_READINESS_REPORT.md`（§36）与最终判定（§37） | 未开始；按目前进度**还不能**给 READY |
