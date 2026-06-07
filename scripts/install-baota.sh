#!/usr/bin/env bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env.production"
DEFAULT_DATA_DIR="/www/wwwroot/video-workbench-data"
DEFAULT_PORT="3000"
DEFAULT_API_BASE_URL="https://ai.772.ee"
DEFAULT_MAX_UPLOAD_FILES="9"
DEFAULT_MAX_UPLOAD_MB="10"
DEFAULT_NODE_MAJOR="20"
APP_USER="www"
NODE_BIN=""
NPM_BIN=""

collect_node_candidates() {
  local tool="$1"
  find /www/server/nodejs -maxdepth 3 \( -type f -o -type l \) -path "*/bin/$tool" 2>/dev/null | sort -r || true
}

log() {
  printf '[install] %s\n' "$1"
}

fail() {
  printf '[install] error: %s\n' "$1" >&2
  exit 1
}

prompt() {
  local label="$1"
  local default_value="${2:-}"
  local required="${3:-0}"
  local value=""

  if [ -n "$default_value" ]; then
    printf '%s [%s]: ' "$label" "$default_value" > /dev/tty
  else
    printf '%s: ' "$label" > /dev/tty
  fi

  IFS= read -r value < /dev/tty || true
  value="${value:-$default_value}"

  if [ "$required" = "1" ] && [ -z "$value" ]; then
    fail "$label 不能为空"
  fi

  printf '%s' "$value"
}

confirm() {
  local label="$1"
  local default_answer="${2:-y}"
  local answer=""

  if [ "$default_answer" = "y" ]; then
    printf '%s [Y/n]: ' "$label" > /dev/tty
  else
    printf '%s [y/N]: ' "$label" > /dev/tty
  fi

  IFS= read -r answer < /dev/tty || true
  answer="${answer:-$default_answer}"

  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

detect_tool() {
  local name="$1"
  shift

  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"
    return 0
  fi

  local candidate=""
  for candidate in "$@"; do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done

  return 1
}

print_node_help() {
  cat <<'EOF' >&2
[install] 未找到 Node.js / npm。

请先在宝塔安装 Node 运行环境，然后重新执行脚本。

常见处理方式：
1. 宝塔面板 -> 软件商店 -> 安装 Node.js 版本，建议 22 LTS
2. 宝塔面板 -> 网站 -> Node 项目，确认 Node 已可用
3. 手动检查以下路径是否存在：
   /www/server/nodejs/*/bin/node
   /www/server/nodejs/*/bin/npm

如果已经安装，可先执行：
export PATH=/www/server/nodejs/*/bin:$PATH

再重新运行：
./scripts/install-baota.sh
EOF
}

check_node() {
  local line=""
  local node_candidates=()
  local npm_candidates=()

  while IFS= read -r line; do
    [ -n "$line" ] && node_candidates+=("$line")
  done < <(collect_node_candidates node)

  while IFS= read -r line; do
    [ -n "$line" ] && npm_candidates+=("$line")
  done < <(collect_node_candidates npm)

  NODE_BIN="$(detect_tool node \
    "${node_candidates[@]}" \
    /usr/local/bin/node \
    /usr/bin/node \
    /bin/node)" || true

  NPM_BIN="$(detect_tool npm \
    "${npm_candidates[@]}" \
    /usr/local/bin/npm \
    /usr/bin/npm \
    /bin/npm)" || true

  if [ -z "$NODE_BIN" ] || [ -z "$NPM_BIN" ]; then
    print_node_help
    fail "缺少命令: node 或 npm"
  fi

  local version major
  version="$("$NODE_BIN" -p "process.versions.node")"
  major="${version%%.*}"

  if [ "$major" -lt "$DEFAULT_NODE_MAJOR" ]; then
    fail "Node.js 版本过低，当前 $version，要求 >= 20.9.0"
  fi

  export PATH
  PATH="$(dirname "$NODE_BIN"):$PATH"

  log "Node.js 版本 $version"
}

random_secret() {
  "$NODE_BIN" -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
}

ensure_dir() {
  local path="$1"
  mkdir -p "$path"
}

write_env_file() {
  local video_api_base_url="$1"
  local server_secret="$2"
  local sqlite_path="$3"
  local port="$4"
  local max_upload_files="$5"
  local max_upload_mb="$6"
  local r2_endpoint="$7"
  local r2_bucket="$8"
  local r2_access_key_id="$9"
  local r2_secret_access_key="${10}"
  local r2_public_base_url="${11}"

  cat >"$ENV_FILE" <<EOF
NODE_ENV=production
PORT=$port
VIDEO_API_BASE_URL=$video_api_base_url
SERVER_SECRET=$server_secret
SQLITE_PATH=$sqlite_path
MAX_UPLOAD_FILES=$max_upload_files
MAX_UPLOAD_FILE_SIZE_MB=$max_upload_mb
R2_ENDPOINT=$r2_endpoint
R2_BUCKET=$r2_bucket
R2_ACCESS_KEY_ID=$r2_access_key_id
R2_SECRET_ACCESS_KEY=$r2_secret_access_key
R2_PUBLIC_BASE_URL=$r2_public_base_url
EOF
}

show_summary() {
  local port="$1"
  local domain="$2"

  cat <<EOF

安装完成。

关键文件：
- 环境文件: $ENV_FILE
- 项目目录: $PROJECT_DIR

宝塔 Node 项目建议：
- 启动命令: npm run start
- 端口: $port
- 运行目录: $PROJECT_DIR

Nginx 反向代理：
- 目标: http://127.0.0.1:$port

建议追加：
client_max_body_size 128m;
proxy_connect_timeout 300s;
proxy_send_timeout 300s;
proxy_read_timeout 300s;

健康检查：
- 本机: curl http://127.0.0.1:$port/api/health
EOF

  if [ -n "$domain" ]; then
    printf -- "- 域名: curl https://%s/api/health\n" "$domain"
  fi
}

main() {
  cd "$PROJECT_DIR"
  check_node

  log "开始生成宝塔生产配置"

  local domain
  local data_dir
  local sqlite_path
  local video_api_base_url
  local server_secret
  local port
  local max_upload_files
  local max_upload_mb
  local r2_enabled="0"
  local r2_endpoint=""
  local r2_bucket=""
  local r2_access_key_id=""
  local r2_secret_access_key=""
  local r2_public_base_url=""

  domain="$(prompt "站点域名（仅用于输出健康检查地址，可留空）" "")"
  data_dir="$(prompt "SQLite 数据目录" "$DEFAULT_DATA_DIR" "1")"
  port="$(prompt "生产端口" "$DEFAULT_PORT" "1")"
  video_api_base_url="$(prompt "视频中转地址" "$DEFAULT_API_BASE_URL" "1")"
  max_upload_files="$(prompt "最大参考图数量" "$DEFAULT_MAX_UPLOAD_FILES" "1")"
  max_upload_mb="$(prompt "单张图片大小限制 MB" "$DEFAULT_MAX_UPLOAD_MB" "1")"

  if confirm "自动生成新的 SERVER_SECRET？" "y"; then
    server_secret="$(random_secret)"
    log "已生成新的 SERVER_SECRET"
  else
    server_secret="$(prompt "请输入 SERVER_SECRET" "" "1")"
  fi

  if confirm "启用 Cloudflare R2？" "y"; then
    r2_enabled="1"
    r2_endpoint="$(prompt "R2_ENDPOINT" "" "1")"
    r2_bucket="$(prompt "R2_BUCKET" "" "1")"
    r2_access_key_id="$(prompt "R2_ACCESS_KEY_ID" "" "1")"
    r2_secret_access_key="$(prompt "R2_SECRET_ACCESS_KEY" "" "1")"
    r2_public_base_url="$(prompt "R2_PUBLIC_BASE_URL" "" "1")"
  fi

  ensure_dir "$data_dir"
  sqlite_path="$data_dir/video.db"

  if id "$APP_USER" >/dev/null 2>&1; then
    if confirm "将项目目录和数据目录授权给 $APP_USER 用户？" "y"; then
      chown -R "$APP_USER:$APP_USER" "$PROJECT_DIR" "$data_dir" || log "chown 失败，请手动处理权限"
    fi
  fi

  write_env_file \
    "$video_api_base_url" \
    "$server_secret" \
    "$sqlite_path" \
    "$port" \
    "$max_upload_files" \
    "$max_upload_mb" \
    "$r2_endpoint" \
    "$r2_bucket" \
    "$r2_access_key_id" \
    "$r2_secret_access_key" \
    "$r2_public_base_url"

  log "已写入 $ENV_FILE"

  if confirm "现在执行 npm install？" "y"; then
    "$NPM_BIN" install
  fi

  if confirm "现在执行 npm run build？" "y"; then
    "$NPM_BIN" run build
  fi

  if [ "$r2_enabled" = "1" ]; then
    log "R2 已启用"
  else
    log "R2 未启用，生产长任务不建议使用直传模式"
  fi

  show_summary "$port" "$domain"
}

main "$@"
