#!/usr/bin/env bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_BRANCH="main"
DEFAULT_NODE_MAJOR="20"
DEFAULT_PORT="3000"
LOG_FILE="$PROJECT_DIR/.next-start.log"
NODE_BIN=""
NPM_BIN=""
START_PID=""
BRANCH="${1:-$DEFAULT_BRANCH}"

collect_node_candidates() {
  local tool="$1"
  find /www/server/nodejs -maxdepth 3 \( -type f -o -type l \) -path "*/bin/$tool" 2>/dev/null | sort -r || true
}

log() {
  printf '[deploy] %s\n' "$1"
}

fail() {
  printf '[deploy] error: %s\n' "$1" >&2
  exit 1
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

check_git_repo() {
  if [ ! -d "$PROJECT_DIR/.git" ]; then
    fail "当前目录不是 Git 仓库：$PROJECT_DIR"
  fi
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
    fail "未找到 node 或 npm，请先安装 Node.js 并确认 PATH 可用。"
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

check_env_file() {
  if [ ! -f "$PROJECT_DIR/.env.production" ]; then
    log "未找到 .env.production，将使用系统环境变量或默认值继续构建"
  fi
}

get_app_port() {
  local port="$DEFAULT_PORT"

  if [ -f "$PROJECT_DIR/.env.production" ]; then
    port="$(grep -E '^PORT=' "$PROJECT_DIR/.env.production" | tail -n 1 | cut -d '=' -f 2- || true)"
    port="${port:-$DEFAULT_PORT}"
  fi

  printf '%s' "$port"
}

get_port_pids() {
  local port="$1"
  local pids=""

  if command -v lsof >/dev/null 2>&1; then
    pids="$(
      {
        lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
        lsof -t -i:"$port" 2>/dev/null || true
      } | sort -u
    )"
  fi

  if [ -z "$pids" ] && command -v fuser >/dev/null 2>&1; then
    pids="$(fuser -n tcp "$port" 2>/dev/null | tr ' ' '\n' | sort -u || true)"
  fi

  if [ -z "$pids" ] && command -v ss >/dev/null 2>&1; then
    pids="$(ss -ltnp "sport = :$port" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | sort -u || true)"
  fi

  printf '%s' "$pids"
}

wait_port_closed() {
  local port="$1"
  local attempt=""

  for attempt in 1 2 3 4 5; do
    if [ -z "$(get_port_pids "$port")" ]; then
      return 0
    fi
    sleep 1
  done

  return 1
}

stop_existing_app() {
  local port="$1"
  local pids=""

  pids="$(get_port_pids "$port")"
  if [ -z "$pids" ]; then
    log "端口 $port 没有运行中的旧进程"
    return 0
  fi

  log "停止端口 $port 旧进程: $pids"
  kill $pids 2>/dev/null || true
  wait_port_closed "$port" || true

  pids="$(get_port_pids "$port")"
  if [ -n "$pids" ]; then
    log "旧进程未退出，强制停止: $pids"
    kill -9 $pids 2>/dev/null || true
    wait_port_closed "$port" || fail "端口 $port 仍被占用，请手动检查：ss -ltnp 'sport = :$port'"
  fi
}

start_app() {
  local port="$1"

  log "启动生产服务，端口 $port"
  : >"$LOG_FILE"
  PORT="$port" NODE_ENV=production nohup "$NPM_BIN" run start >"$LOG_FILE" 2>&1 &
  START_PID="$!"
  sleep 4

  if ! kill -0 "$START_PID" 2>/dev/null; then
    tail -n 120 "$LOG_FILE" >&2 || true
    fail "生产服务启动失败，请查看日志：$LOG_FILE"
  fi
}

check_health() {
  local port="$1"
  local url="http://127.0.0.1:$port/api/health"
  local attempt=""

  log "检查健康接口 $url"
  for attempt in 1 2 3 4 5; do
    if curl -fsS "$url" >/dev/null; then
      log "健康检查通过"
      return 0
    fi
    sleep 2
  done

  tail -n 80 "$LOG_FILE" >&2 || true
  fail "健康检查失败，请查看日志：$LOG_FILE"
}

main() {
  local port=""

  cd "$PROJECT_DIR"
  check_git_repo
  check_node
  check_env_file

  log "拉取远端分支 origin/$BRANCH"
  git fetch origin "$BRANCH"
  git checkout "$BRANCH"
  git pull --ff-only origin "$BRANCH"

  log "安装依赖"
  "$NPM_BIN" install

  log "执行生产构建"
  "$NPM_BIN" run build

  port="$(get_app_port)"
  stop_existing_app "$port"
  start_app "$port"
  check_health "$port"

  cat <<EOF

[deploy] 更新完成。

服务已自动重启。

检查命令：
   curl http://127.0.0.1:$port/api/health

运行日志：
   tail -n 120 $LOG_FILE

EOF
}

main "$@"
