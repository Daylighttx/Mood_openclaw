#!/usr/bin/env bash
# =============================================================================
# clawdctl.sh — Mood_OpenClaw Gateway 进程管理
# =============================================================================
# 用法:
#   bash clawdctl.sh start          启动
#   bash clawdctl.sh stop           停止
#   bash clawdctl.sh status         查看状态
#   bash clawdctl.sh restart        重启
#   bash clawdctl.sh log            实时日志 (tail -f)
#   bash clawdctl.sh log -n 50      最近 50 行日志
# =============================================================================
set -euo pipefail

# Auto-detect OPENCLAW_HOME from script location (scripts/ → .openclaw/ → OPENCLAW_HOME)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OPENCLAW_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
OPENCLAW_HOME="${OPENCLAW_HOME:-$(cd "${OPENCLAW_DIR}/.." && pwd)}"

PID_FILE="${OPENCLAW_DIR}/gw.pid"
LOG_FILE="${OPENCLAW_HOME}/gw.log"
NODE_BIN="$(command -v node || echo node)"
GATEWAY_PORT="${GATEWAY_PORT:-18789}"

usage() {
  echo "用法: bash clawdctl.sh {start|stop|status|restart|log [-n N]}"
  echo ""
  echo "  start     启动 Gateway"
  echo "  stop      停止 Gateway"
  echo "  status    查看运行状态"
  echo "  restart   重启 Gateway"
  echo "  log       实时日志 (等同于 tail -f gw.log)"
  echo "  log -n N  最近 N 行日志"
  exit 0
}

read_pid() {
  if [ -f "$PID_FILE" ]; then
    cat "$PID_FILE"
  else
    echo ""
  fi
}

is_running() {
  local pid
  pid="$(read_pid)"
  if [ -z "$pid" ]; then
    return 1
  fi
  kill -0 "$pid" 2>/dev/null
}

cmd_start() {
  if is_running; then
    echo "[!!] Gateway 已在运行 (pid $(read_pid))"
    return 1
  fi

  if [ ! -f "${OPENCLAW_DIR}/openclaw.mjs" ]; then
    echo "[ERR] 找不到 ${OPENCLAW_DIR}/openclaw.mjs，请确认已正确解压 release 包"
    return 1
  fi

  cd "${OPENCLAW_DIR}"

  nohup "${NODE_BIN}" openclaw.mjs gateway run --port "${GATEWAY_PORT}" \
    > "${LOG_FILE}" 2>&1 &

  local pid="$!"
  echo "$pid" > "$PID_FILE"

  # 等 3 秒确认进程没立刻挂
  sleep 3
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "[ERR] Gateway 启动后立即退出，查看日志: tail -20 ${LOG_FILE}"
    rm -f "$PID_FILE"
    return 1
  fi

  echo "[OK] Gateway 已启动 (pid $pid)"
  echo "     日志: ${LOG_FILE}"
  echo "     端口: ${GATEWAY_PORT}"
}

cmd_stop() {
  local pid
  pid="$(read_pid)"

  if [ -z "$pid" ]; then
    echo "[!!] Gateway 未运行 (无 pid 文件)"
    return 0
  fi

  if ! kill -0 "$pid" 2>/dev/null; then
    echo "[!!] pid $pid 对应的进程不存在，清理 pid 文件"
    rm -f "$PID_FILE"
    return 0
  fi

  echo "正在停止 Gateway (pid $pid)..."
  kill "$pid" 2>/dev/null || true

  # 等 5 秒看进程是否退出
  for i in 1 2 3 4 5; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "[OK] Gateway 已停止"
      rm -f "$PID_FILE"
      return 0
    fi
    sleep 1
  done

  # 强行结束
  echo "进程未响应，强制终止..."
  kill -9 "$pid" 2>/dev/null || true
  sleep 1
  rm -f "$PID_FILE"
  echo "[OK] Gateway 已强制停止"
}

cmd_status() {
  if is_running; then
    local pid
    pid="$(read_pid)"
    echo "Gateway 状态: 运行中"
    echo "  PID:  $pid"
    if [ -f "$LOG_FILE" ]; then
      echo "  日志: $LOG_FILE"
      echo "  --- 最近 5 行 ---"
      tail -5 "$LOG_FILE" 2>/dev/null || true
    fi
  else
    echo "Gateway 状态: 未运行"
    if [ -f "$PID_FILE" ]; then
      echo "  (过期的 pid 文件: $(cat "$PID_FILE"))"
    fi
  fi
}

cmd_restart() {
  cmd_stop || true
  sleep 2
  cmd_start
}

cmd_log() {
  local lines=""
  if [ "${1:-}" = "-n" ] && [ -n "${2:-}" ]; then
    lines="$2"
  fi

  if [ -n "$lines" ]; then
    tail -n "$lines" "$LOG_FILE" 2>/dev/null || echo "(日志文件不存在)"
  else
    echo "实时日志 (Ctrl+C 退出)..."
    tail -f "$LOG_FILE" 2>/dev/null || echo "(日志文件不存在，请先启动 Gateway)"
  fi
}

# ── 主入口 ──
case "${1:-help}" in
  start)    shift; cmd_start "$@";;
  stop)     shift; cmd_stop "$@";;
  status)   shift; cmd_status "$@";;
  restart)  shift; cmd_restart "$@";;
  log)      shift; cmd_log "$@";;
  help|-h|--help) usage;;
  *)        echo "未知命令: ${1:-}"; usage;;
esac
