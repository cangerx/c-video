# C-AI

高完成度的异步 AI 视频生成工作台。

C-AI 面向需要稳定调用视频模型的独立创作者、工作室与内部团队，提供一套可直接部署的 Web 工作台：用户使用自己的中转密钥登录，提交视频生成任务，异步轮询状态，复用历史提示词与参考图，并直接使用上游返回的视频链接进行预览与下载。系统本身不保存视频文件，只负责任务编排、状态管理与操作体验。

作者：苍洱  
版权声明：未经授权，不得商用。

## 产品概览

- 聚焦单一视频模型工作流，默认接入 `Seedance 2.0`
- 固定 720p 输出，支持 5-15 秒时长与多种画幅比例
- 支持本地图片上传、粘贴上传、拖拽上传与远程 URL 引用
- 支持 Cloudflare R2 转存，提升长任务场景下的参考图稳定性
- 任务异步提交、自动轮询、失败重试、取消、详情查看与历史复用
- 最近 30 天任务与本地用量记录持久化保存
- 不落盘保存视频，只使用上游返回的 `video_url`

## 核心能力

### 1. 密钥即身份

前端不创建传统账号体系，用户直接使用中转密钥登录。服务端不会明文存储密钥，只保存：

```text
sha256(apiKey + SERVER_SECRET)
```

这使得系统能够在不持有原始密钥的前提下完成任务历史、用量统计与本地用户隔离。

### 2. 异步视频任务编排

系统面向高时延视频生成链路设计。任务提交后，前端会进入持续轮询流程，并提供：

- 当前任务生成态展示
- 历史任务后台轮询
- 浏览器通知
- 失败后原位重试
- 任务详情回看与二次复用

对于 15 到 60 分钟的长任务，界面交互重点是“可离开、可回来、可继续提交下一条”，而不是阻塞式等待。

### 3. 参考图稳定上传

参考图有两种工作模式：

- `R2 模式`
  本地图片先转存为公网 URL，再提交给上游
- `Direct 模式`
  未配置对象存储时，图片直接随请求传给上游

生产环境推荐启用 R2 或同类对象存储。对于视频长任务，避免依赖服务器本地临时文件是必要的稳定性策略。

### 4. 本地任务与用量账本

系统使用 SQLite 保存最近 30 天的数据：

- 视频任务记录
- 任务状态
- 参考图 URL
- 创建 / 重试用量事件

当前用量为本地账本，用于站内展示与运营统计，不直接参与上游账户余额扣减。

## 技术栈

- Next.js 16
- React 19
- TypeScript
- SQLite (`better-sqlite3`)
- Cloudflare R2（可选）

## 系统架构

```text
Browser
  -> Next.js App
    -> SQLite (task history / usage ledger)
    -> Cloudflare R2 (optional, for reference images)
    -> Upstream Video API (https://ai.772.ee)
```

职责边界：

- C-AI 负责登录、任务提交、历史记录、状态轮询、参考图管理、用量记录
- 上游服务负责视频任务执行、排队、渲染与视频 URL 回传
- 视频文件本身不由 C-AI 持久化保存

## 功能清单

- 视频提示词输入与字数限制
- 5-15 秒时长控制
- 多画幅比例切换
- 最多 9 张参考图
- `@IMG_n` 参考图标签工作流
- 本地上传、粘贴上传、拖拽上传
- 远程参考图 URL 管理
- R2 上传成功地址回填
- 最近 30 天任务历史
- 任务详情弹窗
- 任务取消、重试、刷新
- 浏览器完成通知
- 健康检查接口 `/api/health`

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 初始化环境变量

```bash
cp .env.example .env.local
```

### 3. 启动开发环境

```bash
npm run dev
```

浏览器访问：

```text
http://localhost:3000
```

## 环境变量

```bash
VIDEO_API_BASE_URL=https://ai.772.ee
SERVER_SECRET=change-this-long-random-secret
SQLITE_PATH=./data/video.db
MAX_UPLOAD_FILES=9
MAX_UPLOAD_FILE_SIZE_MB=10

# Optional: Cloudflare R2
R2_ACCOUNT_ID=
R2_ENDPOINT=
R2_BUCKET=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_PUBLIC_BASE_URL=
```

说明：

- `SERVER_SECRET`
  生产环境必须替换，不能使用默认占位值
- `SQLITE_PATH`
  建议指向持久化目录，例如 `/data/video.db`
- `MAX_UPLOAD_FILES`
  当前推荐与上游约束保持一致，默认 `9`
- `R2_PUBLIC_BASE_URL`
  必须是公网可访问域名

## 本地验证

```bash
npm run typecheck
npm run build
```

如果构建与类型检查均通过，再进入部署阶段。

## 生产部署

### BaoTa / PM2 / Node 项目

推荐使用宝塔 Node 项目或 PM2 管理服务，Node 版本要求：

```text
>= 20.9.0
```

启动命令：

```bash
npm run start
```

默认服务端口：

```text
3000
```

### 一键安装脚本

仓库内已提供宝塔安装脚本：

```bash
chmod +x scripts/install-baota.sh
./scripts/install-baota.sh
```

脚本会完成：

- Node 版本检查
- `.env.production` 生成
- SQLite 数据目录创建
- 可选 `npm install`
- 可选 `npm run build`
- 输出宝塔启动参数与健康检查地址

更详细的部署步骤见：

- [BAOTA_INSTALL.md](/Users/canger/Documents/code/video/BAOTA_INSTALL.md)

### Git 拉取更新

如果服务器目录已经通过 Git 克隆本仓库，后续可直接使用更新脚本：

```bash
chmod +x scripts/deploy-pull.sh
./scripts/deploy-pull.sh
```

如需指定分支：

```bash
./scripts/deploy-pull.sh main
```

脚本会自动执行：

- `git fetch`
- `git pull --ff-only`
- `npm install`
- `npm run build`

完成后只需在宝塔 Node 项目中重启服务。

## Nginx 反向代理

推荐将域名反向代理到：

```text
http://127.0.0.1:3000
```

建议追加：

```nginx
client_max_body_size 128m;
proxy_connect_timeout 300s;
proxy_send_timeout 300s;
proxy_read_timeout 300s;
```

## 健康检查

部署完成后，可通过以下接口确认服务状态：

```bash
curl https://your-domain.example.com/api/health
```

期望返回：

```json
{
  "ok": true,
  "database": { "ok": true },
  "r2Configured": true,
  "serverSecretConfigured": true
}
```

重点关注：

- `ok`
  服务与数据库是否正常
- `serverSecretConfigured`
  生产环境必须为 `true`
- `r2Configured`
  若为 `false`，说明当前未启用对象存储

## 运维建议

- 使用正式 SSL 证书，不要长期保留自签名证书
- 生产环境启用 R2 或同类对象存储
- SQLite 数据目录独立持久化
- 上游长任务轮询间隔保持在 10-30 秒区间
- 每次升级后先执行 `npm run build`
- 对中转密钥、R2 密钥和 `SERVER_SECRET` 做定期轮换

## 已知边界

- 当前版本默认单实例部署，适合轻量工作台场景
- 用量系统是本地记录，不等同于上游钱包系统
- 视频文件不托管，完全依赖上游返回链接
- 若未来扩展到多实例或更强运营能力，建议迁移到 PostgreSQL

## 版权与使用限制

本项目作者为苍洱。

除非获得明确书面授权，否则：

- 不得商用
- 不得以白标、二开 SaaS、付费分发等方式再次销售
- 不得移除作者与版权声明

如需商业授权，请联系作者。
