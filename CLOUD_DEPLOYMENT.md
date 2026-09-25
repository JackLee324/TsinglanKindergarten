# TsinglanKindergarten 云托管平台一键上线指南

本项目已完成全套生产加固与云端 PaaS 适配，支持在 **Zeabur**、**Render**、**Railway** 或任何支持 Docker 的云平台上**一键上线**。

---

## 推荐方式一：Zeabur 上线（推荐，速度快、操作简单）

Zeabur 提供了极其简便的容器托管与数据库托管：

### 1. 推送代码到 GitHub
在本地终端或当前项目目录下执行：
```bash
# 1. 在 GitHub 上创建一个新仓库，命名为 TsinglanKindergarten
# 2. 推送当前代码到 GitHub：
git remote add origin https://github.com/<你的GitHub用户名>/TsinglanKindergarten.git
git branch -M main
git push -u origin main
```

### 2. 在 Zeabur 部署
1. 访问 [Zeabur 官网](https://zeabur.com/) 并使用 GitHub 登录。
2. 点击 **Create Project**（创建项目）。
3. 点击 **Deploy New Service** -> 选择 **GitHub** -> 选择刚才推送的 `TsinglanKindergarten` 仓库。
4. 在同一个项目内，点击 **+ Create Service** -> 选择 **Database** -> 选择 **PostgreSQL**。
5. Zeabur 会自动将数据库连接串 `DATABASE_URL` 注入到应用中。
6. 进入应用服务的 **Variables**（环境变量），添加以下密钥（可在本地终端用 `openssl rand -base64 32` 生成）：
   - `MFA_ENCRYPTION_KEY`: 随机32字节Base64字符串
   - `DOWNLOAD_TOKEN_SECRET`: 随机32字节Base64字符串
   - `INITIAL_ADMIN_USER`: `TsinglanAdmin`
   - `INITIAL_ADMIN_PASSWORD`: 设置你的管理员密码（例如 `Tsinglan2026!`）
7. 进入应用服务的 **Networking**（网络）页面，点击 **Generate Domain**（生成域名），获得一个免费的公网 HTTPS 域名（例如 `https://tsinglankindergarten.zeabur.app`）。
8. 容器启动时会自动初始化数据库表结构并创建初始超级管理员，访问域名即可直接登录！

---

## 推荐方式二：Render 蓝图一键上线（全自动配置数据库与密钥）

项目根目录已内置 `render.yaml` 自动化蓝图，无需手动配置环境变量与数据库：

1. 将代码推送到 GitHub 的 `TsinglanKindergarten` 仓库。
2. 登录 [Render Dashboard](https://dashboard.render.com/)。
3. 点击顶部 **New +** -> 选择 **Blueprint**。
4. 连接你的 GitHub 账号并选中 `TsinglanKindergarten` 仓库。
5. Render 会自动识别 `render.yaml`，自动配置：
   - 托管 PostgreSQL 数据库（`tsinglan-postgres`）
   - Web 服务容器（`tsinglan-kindergarten`）
   - 自动生成 `MFA_ENCRYPTION_KEY`、`DOWNLOAD_TOKEN_SECRET` 与 `INITIAL_ADMIN_PASSWORD`
6. 点击 **Apply** 即可全自动构建与上线！
7. 部署完成后，在 Render 控制台查看生成的域名（如 `https://tsinglan-kindergarten.onrender.com`）与初始管理员密码。

---

## 推荐方式三：Railway 上线

1. 登录 [Railway](https://railway.app/)。
2. 点击 **New Project** -> **Deploy from GitHub repo** -> 选择 `TsinglanKindergarten`。
3. 在 Canvas 中点击 **+ New** -> **Database** -> **Add PostgreSQL**。
4. 在应用服务设置中配置环境变量（或使用 `.env.cloud.example` 中的变量）。
5. 在 Networking 栏点击 **Generate Domain** 生成公网访问地址。

---

## 本地与独立服务器部署（备选）

如果你拥有自己的独立云服务器（Linux VPS / 阿里云 / 腾讯云等）：
```bash
# 复制环境变量并填写
cp .env.deploy.example .env.deploy

# 一键启动服务与内置数据库
docker compose up -d --build
```
