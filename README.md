# C-AI

作者：苍洱

版权声明：未经授权，不得商用。

一个用于调用异步视频生成中转接口的单体网站。用户输入自己的中转密钥后创建视频任务，服务端代理请求 `https://ai.772.ee`，并用 SQLite 保存最近 30 天任务记录。视频文件不保存，只使用上游返回的 `video_url` 做预览和下载。

## 功能

- 用户密钥作为身份来源，数据库只保存 `sha256(apiKey + SERVER_SECRET)`。
- 固定调用 Seedance 2.0 视频模型，支持提示词、5-15 秒、画幅尺寸和参考素材 URL。
- 支持上传参考图片；配置 R2 后先转存为公网 URL，未配置时自动直传给上游。
- 创建任务后自动轮询状态。
- 保存最近 30 天任务记录和创建/重试用量记录，支持刷新、取消、重试、任务详情。
- 完成后直接用上游 `video_url` 播放。
- 支持上传限制、友好错误文案和浏览器完成通知。

## 开发

```bash
cp .env.example .env.local
npm install
npm run dev
```

打开 `http://localhost:3000`。

## 环境变量

```bash
VIDEO_API_BASE_URL=https://ai.772.ee
SERVER_SECRET=change-this-long-random-secret
SQLITE_PATH=./data/video.db
MAX_UPLOAD_FILES=9
MAX_UPLOAD_FILE_SIZE_MB=10

# 可选：Cloudflare R2。留空时走直传上游。
R2_ACCOUNT_ID=
R2_ENDPOINT=
R2_BUCKET=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_PUBLIC_BASE_URL=
```

生产环境必须替换 `SERVER_SECRET`。如果使用 Docker 或 VPS 部署，建议把 SQLite 放在持久化目录，例如 `/data/video.db`。

`R2_PUBLIC_BASE_URL` 必须是可公开访问的 bucket 域名或自定义域名，例如 `https://assets.example.com`。开启 R2 后，本地上传图片会转为公网 URL 再提交给上游，长任务期间比服务器本地临时文件更稳定。

## 验证

```bash
npm run typecheck
npm run build
```

部署后可用健康检查确认进程、SQLite 和 R2 配置状态：

```bash
curl https://your-domain.example.com/api/health
```

返回里的 `ok` 应为 `true`，`serverSecretConfigured` 生产环境必须为 `true`。`r2Configured` 为 `true` 表示参考图会先转存到 R2。

## 宝塔部署

建议使用宝塔 Node 项目或 PM2 管理，运行前确认 Node.js 版本不低于 `20.9.0`。

如果希望减少手动配置，优先使用：

```bash
chmod +x scripts/install-baota.sh
./scripts/install-baota.sh
```

1. 上传项目代码到服务器，例如 `/www/wwwroot/video-workbench`。
2. 在项目目录执行 `npm install` 和 `npm run build`。
3. 配置生产环境变量，至少设置 `SERVER_SECRET`、`SQLITE_PATH` 和 R2 相关变量。
4. 启动命令使用 `npm run start`，端口默认 `3000`，也可设置环境变量 `PORT=3000`。
5. 在宝塔网站反向代理到 `http://127.0.0.1:3000`。

推荐生产环境变量示例：

```bash
NODE_ENV=production
PORT=3000
VIDEO_API_BASE_URL=https://ai.772.ee
SERVER_SECRET=replace-with-a-long-random-secret
SQLITE_PATH=/www/wwwroot/video-workbench-data/video.db
MAX_UPLOAD_FILES=9
MAX_UPLOAD_FILE_SIZE_MB=10

R2_ENDPOINT=https://your-account.r2.cloudflarestorage.com
R2_BUCKET=videos-ai
R2_ACCESS_KEY_ID=replace-with-r2-access-key
R2_SECRET_ACCESS_KEY=replace-with-r2-secret-key
R2_PUBLIC_BASE_URL=https://oss.example.com
```

宝塔 / Nginx 反代建议追加：

```nginx
client_max_body_size 128m;
proxy_connect_timeout 300s;
proxy_send_timeout 300s;
proxy_read_timeout 300s;
```

如果 `better-sqlite3` 在服务器安装失败，通常是缺少原生编译环境。Debian/Ubuntu 可安装：

```bash
apt install -y python3 make g++
```

## 部署要点

- 使用 Node.js 运行，不要部署到纯 Edge Runtime。
- 挂载 SQLite 数据目录，避免容器重建后丢失任务记录。
- 生产环境建议配置 R2 或同类对象存储；不要依赖服务器本地临时文件承载参考图。
- 用量记录是本地 ledger：成功创建和重试任务后记录消耗，不做账户余额扣减。
- 当前设计适合单实例部署；如果未来多实例扩容，建议迁移到 PostgreSQL。
