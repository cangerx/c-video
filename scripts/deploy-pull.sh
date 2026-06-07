#!/usr/bin/env bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_BRANCH="main"
DEFAULT_NODE_MAJOR="20"
NODE_BIN=""
NPM_BIN=""
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

main() {
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

  cat <<EOF

[deploy] 更新完成。

下一步：
1. 在宝塔 Node 项目中重启服务
2. 或使用你的进程管理器重启当前应用
3. 检查健康接口：
   curl http://127.0.0.1:3000/api/health

EOF
}

main "$@"
