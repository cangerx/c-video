# 宝塔部署安装文档

本文档用于把 `video-workbench` 部署到宝塔面板。部署前请确认已经更换生产用的中转密钥、Cloudflare R2 密钥和 `SERVER_SECRET`。

## 1. 环境要求

- Node.js：`>= 20.9.0`，建议使用 Node `22 LTS`。
- 进程管理：宝塔「Node 项目」或 PM2。
- 数据库：SQLite，本项目会自动创建表。
- 参考图存储：建议配置 Cloudflare R2。

如果服务器安装 `better-sqlite3` 失败，先安装原生编译依赖。

Debian / Ubuntu：

```bash
apt update
apt install -y python3 make g++
```

CentOS / AlmaLinux / Rocky Linux：

```bash
yum install -y python3 make gcc gcc-c++
```

## 2. 推荐方式

如果不想手动配置环境变量，优先使用一键脚本：

```bash
cd /www/wwwroot/video-workbench
chmod +x scripts/install-baota.sh
./scripts/install-baota.sh
```

如果脚本提示找不到 `node` 或 `npm`，通常是宝塔已安装 Node，但当前 shell 没带上 PATH。可先执行：

```bash
export PATH=/www/server/nodejs/*/bin:$PATH
./scripts/install-baota.sh
```

脚本会交互完成这些动作：

- 检查 Node.js 版本
- 生成 `.env.production`
- 创建 SQLite 数据目录
- 可选执行 `npm install`
- 可选执行 `npm run build`
- 输出宝塔启动参数和健康检查地址

执行完后，再到宝塔里创建 Node 项目并使用 `npm run start` 启动。

## 3. 上传和解压

建议目录：

```bash
/www/wwwroot/video-workbench
/www/wwwroot/video-workbench-data
```

操作步骤：

1. 在宝塔文件管理上传压缩包。
2. 解压到 `/www/wwwroot/video-workbench`。
3. 创建 SQLite 持久化目录：

```bash
mkdir -p /www/wwwroot/video-workbench-data
```

如果宝塔 Node 项目运行用户是 `www`，执行：

```bash
chown -R www:www /www/wwwroot/video-workbench /www/wwwroot/video-workbench-data
```

## 4. 环境变量

可以在宝塔「Node 项目」里填写环境变量，也可以在项目根目录创建 `.env.production`。

生产环境示例：

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

必须确认：

- `SERVER_SECRET` 不能使用默认值，必须是长随机字符串。
- `SQLITE_PATH` 必须指向可写持久化目录。
- `R2_PUBLIC_BASE_URL` 必须是公网可访问域名，例如 `https://oss.example.com`。

## 5. 安装依赖和构建

进入项目目录：

```bash
cd /www/wwwroot/video-workbench
npm install
npm run build
```

构建成功后再启动生产服务。

## 6. 启动命令

宝塔 Node 项目建议：

- 项目目录：`/www/wwwroot/video-workbench`
- 启动命令：`npm run start`
- 端口：`3000`
- Node 版本：`20.9.0+`

如果使用 PM2：

```bash
cd /www/wwwroot/video-workbench
PORT=3000 npm run start
```

不要用 `npm run dev` 跑生产环境。

## 7. Nginx 反向代理

反向代理目标：

```text
http://127.0.0.1:3000
```

宝塔网站配置里建议追加：

```nginx
client_max_body_size 128m;
proxy_connect_timeout 300s;
proxy_send_timeout 300s;
proxy_read_timeout 300s;
```

如果手动写反代，可以使用：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

## 8. 上线检查

先访问健康检查：

```bash
curl https://你的域名/api/health
```

期望结果：

```json
{
  "ok": true,
  "database": { "ok": true },
  "r2Configured": true,
  "serverSecretConfigured": true
}
```

如果 `serverSecretConfigured` 是 `false`，说明生产 `SERVER_SECRET` 没配置正确，不要继续上线。

如果 `r2Configured` 是 `false`，说明 R2 配置不完整，图片会退回直传模式，不建议用于长任务生产环境。

## 9. 常见问题

`SERVER_SECRET must be set before running in production.`

生产环境没有设置真实 `SERVER_SECRET`，或者仍然使用默认占位值。

`better-sqlite3` 安装失败

Node 版本过低，或系统缺少 `python3 make g++` / `gcc gcc-c++`。

图片上传失败

检查 `R2_ENDPOINT`、`R2_BUCKET`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY` 和 `R2_PUBLIC_BASE_URL`，并确认 R2 自定义域名可公网访问。

接口 413 或上传中断

调大 Nginx `client_max_body_size`，并确认宝塔反代配置已生效。

长时间排队

这是上游视频模型队列行为。前端会自动轮询，视频完成后使用上游返回的 `video_url` 预览和下载。
