# 视频工作台 API 文档

本站对外提供的视频生成接口。所有接口均为本站自有路由（`/api/*`），内部再转发到上游中转服务。

## 鉴权

除 `/api/health` 外，所有接口都需要中转密钥，二选一：

- 请求头 `x-video-api-key: <你的密钥>`
- 请求头 `Authorization: Bearer <你的密钥>`

缺失或无效返回 `401`。

## 在线调试

浏览器打开 `/api-debug.html`，填入密钥即可逐个接口真实调用（创建/重试会计费）。

## 通用错误格式

所有错误统一返回：

```json
{ "error": { "message": "人类可读信息", "code": "错误码", "type": "错误类型" } }
```

常见状态码：`400` 参数错误 · `401` 密钥无效 · `402` 额度不足 · `404` 任务不存在 · `429` 频率限制 · `5xx` 上游/服务异常。

## 模型与能力

| 模型 ID | 名称 | 价格/次 | 时长 | 分辨率 |
|---------|------|---------|------|--------|
| `seedance-2` | Seedance 2（满血） | ¥5 | 15s | 720P |
| `seedance-2.0` | Seedance 2.0 Fast（快速） | ¥2.5 | 15s | 720P / 1080P |
| `seedance-2-vip` | Seedance 2 VIP（满血加速） | ¥7 | 15s | 720P |
| `happyhorse-1.0` | HappyHorse 1.0 | ¥3.5 | 15s | 720P / 1080P |

> 1080P 仅 `seedance-2.0` 与 `happyhorse-1.0` 支持；其余模型传 1080P 会返回 `400`。
> 画幅 `ratio` 支持：16:9 / 9:16 / 1:1 / 4:3 / 3:4。

## 接口列表

### 1. GET /api/health

健康检查，无需密钥。

响应：

```json
{
  "ok": true,
  "database": { "ok": true },
  "r2Configured": true,
  "serverSecretConfigured": true,
  "node": "v20.x.x",
  "uptime": 1234
}
```

### 2. GET /api/videos

任务列表 + 用量汇总。

查询参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `limit` | number | 否 | 返回条数，默认 30 |

响应：

```json
{
  "object": "list",
  "data": [ { "...": "StoredVideoTask" } ],
  "usage": { "totalCostUnits": 12, "recentEvents": [] },
  "r2Configured": true
}
```

### 3. POST /api/videos

创建视频任务。**会计费。** 请求体为 `multipart/form-data`。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prompt` | string | 是 | 提示词，≤3500 字（也接受 `input`） |
| `model` | string | 否 | 模型 ID，默认 `seedance-2`，见模型表 |
| `seconds` | int | 否 | 时长，仅 `15`（也接受 `duration`） |
| `resolution` | string | 否 | `720P` / `1080P`，默认 `720P`（1080P 仅部分模型） |
| `size` | string | 否 | 输出像素，如 `1280x720`，映射为上游 `ratio` |
| `media[]` / `media` | file | 否 | 参考图文件，可多张（配置 R2 时上传） |
| `media_urls` | string | 否 | 参考图公网 URL，可多个（逗号或换行分隔） |

提示词里可用 `@图1`/`@IMG_1` 引用第 N 张参考图。

响应：

```json
{
  "task": { "id": "...", "status": "in_progress", "progress": 0, "...": "UpstreamVideoTask" },
  "storedTask": { "...": "StoredVideoTask" },
  "usage": { "...": "UsageSummary" },
  "storageMode": "r2"
}
```

### 4. GET /api/videos/{id}

查询单个任务状态。`{id}` 为创建返回的 `task.id`（即上游 `task_id`）。

响应同上结构（`task` + `storedTask` + `usage`）。任务永久失败（404/400/unrecognized）时会在本地标记为 `failed`。

### 5. POST /api/videos/{id}/cancel

取消任务。⚠️ 上游文档未列出此端点，真实可用性需验证。

### 6. POST /api/videos/{id}/retry

重试任务。**会计费。** ⚠️ 上游文档未列出此端点，真实可用性需验证。

### 7. POST /api/uploads

上传参考图到 R2，返回公网 URL（用于创建任务的 `media_urls`）。`multipart/form-data`。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `media[]` / `media` | file | 是 | 图片文件，可多张 |

未配置 R2 时返回 `{ "object": "list", "data": [], "storageMode": "direct" }`。

响应：

```json
{
  "object": "list",
  "data": [ { "name": "a.jpg", "size": 12345, "type": "image/jpeg", "url": "https://..." } ],
  "storageMode": "r2"
}
```

## 数据结构

`StoredVideoTask` 字段：`id`(本地自增) · `upstreamTaskId` · `model` · `prompt` · `seconds` · `size` · `mediaUrls[]` · `costUnits` · `status` · `progress` · `videoUrl` · `thumbnailUrl` · `errorMessage` · `errorCode` · `createdAt` · `updatedAt` · `expiresAt`。

`status` 枚举：`queued` / `in_progress` / `completed` / `failed` / `cancelled`。

成片地址优先取 `task.video_url`，上游也可能放在 `url` / `metadata.{url,content_url,local_url}`，本站已做多字段兜底。

