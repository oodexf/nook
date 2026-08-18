#!/usr/bin/env bash
#
# dev.sh — start the full NooK stack for local testing.
#
# Brings up the Rust backend (chat-server), the Vite frontend dev server, and
# (optionally) the local mock OpenAI-compatible provider. Each service runs in
# the background, writes a PID file under .local-data/, and logs to
# .local-data/logs/. The backend reads configuration from .env; this script
# overrides only the bits needed for local dev (loopback bind, mock provider).
#
# Usage:
#   ./scripts/dev.sh                 # start everything (mock provider on)
#   ./scripts/dev.sh start           # same as above
#   ./scripts/dev.sh stop            # stop all services
#   ./scripts/dev.sh restart         # stop then start
#   ./scripts/dev.sh status          # show running services
#   ./scripts/dev.sh logs [svc]      # tail logs (backend|frontend|mock), default all
#
# Flags (only meaningful for start/restart):
#   --no-mock        Use the real provider configured in .env instead of the mock.
#   --no-frontend    Skip the Vite dev server (use the embedded build instead).
#   --no-backend     Skip the backend (e.g. only iterate on the frontend).
#   --release        Build/run the backend in release mode.
#   --port PORT      Backend port (default 8080).
#   --vite-port PORT Vite port (default 5173).
#
set -euo pipefail

# Resolve the project root from the script location so it works from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

DATA_DIR="$ROOT_DIR/.local-data"
LOG_DIR="$DATA_DIR/logs"
mkdir -p "$DATA_DIR" "$LOG_DIR"

BACKEND_PID_FILE="$DATA_DIR/backend.pid"
FRONTEND_PID_FILE="$DATA_DIR/frontend-vite.pid"
MOCK_PID_FILE="$DATA_DIR/mock-provider.pid"
PORT_FILE="$DATA_DIR/backend.port"
VITE_PORT_FILE="$DATA_DIR/frontend.port"

BACKEND_LOG="$LOG_DIR/backend.log"
FRONTEND_LOG="$LOG_DIR/frontend-vite.log"
MOCK_LOG="$LOG_DIR/mock-provider.log"

MOCK_SCRIPT="$DATA_DIR/mock-provider.py"
MOCK_HOST="127.0.0.1"
MOCK_PORT="18081"
MOCK_MODEL="test-model"

DEFAULT_BACKEND_PORT="8080"
DEFAULT_VITE_PORT="5173"

# Defaults for flags.
USE_MOCK=1
START_FRONTEND=1
START_BACKEND=1
RELEASE=0
BACKEND_PORT="$DEFAULT_BACKEND_PORT"
VITE_PORT="$DEFAULT_VITE_PORT"

color() { printf '\033[%sm%s\033[0m' "$1" "$2"; }
info()  { printf '%s %s\n' "$(color '1;36' '▶')" "$*"; }
ok()    { printf '%s %s\n' "$(color '1;32' '✓')" "$*"; }
warn()  { printf '%s %s\n' "$(color '1;33' '!')" "$*" >&2; }
err()   { printf '%s %s\n' "$(color '1;31' '✗')" "$*" >&2; }

# Locate cargo through rustup so the script works even when ~/.cargo/bin is not
# on PATH (rustup-managed toolchains live under ~/.rustup/toolchains). Cargo
# shells out to rustc, so we also export the toolchain's bin dir on PATH.
setup_rust_path() {
  if command -v cargo >/dev/null 2>&1; then
    return
  fi
  if ! command -v rustup >/dev/null 2>&1; then
    return
  fi
  local cargo; cargo="$(rustup which cargo 2>/dev/null || true)"
  if [[ -n "$cargo" ]]; then
    local bin_dir; bin_dir="$(dirname "$cargo")"
    case ":$PATH:" in
      *":$bin_dir:"*) ;;
      *) export PATH="$bin_dir:$PATH" ;;
    esac
  fi
}

cargo_bin() {
  if command -v cargo >/dev/null 2>&1; then
    command -v cargo
  elif command -v rustup >/dev/null 2>&1; then
    rustup which cargo
  else
    echo ""
  fi
}

pid_alive() { local pid="${1:-}"; [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; }

read_pid() {
  local file="$1"
  [[ -f "$file" ]] || { echo ""; return; }
  local pid; pid="$(cat "$file" 2>/dev/null || true)"
  if pid_alive "$pid"; then echo "$pid"; else echo ""; fi
}

stop_pid_file() {
  local name="$1" file="$2"
  local pid; pid="$(read_pid "$file")"
  if [[ -z "$pid" ]]; then
    rm -f "$file"
    info "$name not running."
    return
  fi
  info "stopping $name (pid $pid)…"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 50); do
    pid_alive "$pid" || break
    sleep 0.1
  done
  if pid_alive "$pid"; then
    warn "$name did not exit on SIGTERM, sending SIGKILL."
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$file"
  ok "$name stopped."
}

stop_all() {
  stop_pid_file "backend"  "$BACKEND_PID_FILE"
  stop_pid_file "frontend" "$FRONTEND_PID_FILE"
  stop_pid_file "mock"     "$MOCK_PID_FILE"
  rm -f "$PORT_FILE" "$VITE_PORT_FILE"
}

start_mock() {
  local pid; pid="$(read_pid "$MOCK_PID_FILE")"
  if [[ -n "$pid" ]]; then
    ok "mock provider already running (pid $pid) at http://$MOCK_HOST:$MOCK_PORT/v1"
    return
  fi
  if [[ ! -f "$MOCK_SCRIPT" ]]; then
    err "mock provider script not found: $MOCK_SCRIPT"
    return 1
  fi
  info "starting mock provider on http://$MOCK_HOST:$MOCK_PORT/v1 …"
  nohup python3 "$MOCK_SCRIPT" >"$MOCK_LOG" 2>&1 &
  local new_pid=$!
  echo "$new_pid" >"$MOCK_PID_FILE"
  sleep 0.4
  if pid_alive "$new_pid"; then
    ok "mock provider started (pid $new_pid)."
  else
    err "mock provider failed to start; see $MOCK_LOG"
    rm -f "$MOCK_PID_FILE"
    return 1
  fi
}

start_backend() {
  local pid; pid="$(read_pid "$BACKEND_PID_FILE")"
  if [[ -n "$pid" ]]; then
    ok "backend already running (pid $pid) at http://127.0.0.1:$BACKEND_PORT"
    return
  fi

  setup_rust_path
  local cargo; cargo="$(cargo_bin)"
  if [[ -z "$cargo" ]]; then
    err "cargo not found. Install Rust via https://rustup.rs or add cargo to PATH."
    return 1
  fi

  local profile="debug"
  local extra_env=()
  # Force loopback + dev-friendly cookie settings regardless of .env so the
  # stack is testable over plain HTTP on this machine. APP_ORIGIN must match
  # the origin the browser actually uses (the Vite dev server) so CSRF/origin
  # checks pass; when the frontend is skipped the browser hits the backend
  # directly, so use the backend origin in that case.
  local app_origin="http://127.0.0.1:$BACKEND_PORT"
  if [[ "$START_FRONTEND" -eq 1 ]]; then
    app_origin="http://127.0.0.1:$VITE_PORT"
  fi
  extra_env+=("APP_BIND=127.0.0.1:$BACKEND_PORT")
  extra_env+=("APP_ORIGIN=$app_origin")
  extra_env+=("APP_COOKIE_SECURE=false")
  extra_env+=("APP_ALLOW_INSECURE_TEST_TOKEN=true")
  extra_env+=("APP_ACCESS_TOKEN=test")
  # Keep the dev database local instead of /data/chat.db.
  extra_env+=("DATABASE_PATH=$DATA_DIR/chat.db")
  if [[ "$USE_MOCK" -eq 1 ]]; then
    extra_env+=("AI_BASE_URL=http://$MOCK_HOST:$MOCK_PORT/v1")
    extra_env+=("AI_API_KEY=mock-key")
    extra_env+=("AI_DEFAULT_MODEL=$MOCK_MODEL")
  fi

  if [[ "$RELEASE" -eq 1 ]]; then
    profile="release"
    info "building backend (release)…"
  else
    info "building backend (debug)…"
  fi
  # Build first so failures surface before we try to launch a stale binary.
  if ! RUST_LOG="${RUST_LOG:-info}" "$cargo" build --bin chat-server ${RELEASE:+--release}; then
    err "backend build failed."
    return 1
  fi

  local bin="$ROOT_DIR/target/$profile/chat-server"
  info "starting backend at http://127.0.0.1:$BACKEND_PORT …"
  echo "$BACKEND_PORT" >"$PORT_FILE"
  env "${extra_env[@]}" RUST_LOG="${RUST_LOG:-info}" \
    nohup "$bin" >"$BACKEND_LOG" 2>&1 &
  local new_pid=$!
  echo "$new_pid" >"$BACKEND_PID_FILE"

  # Wait for readiness (liveness endpoint) up to ~20s.
  local ready=0
  for _ in $(seq 1 100); do
    if ! pid_alive "$new_pid"; then
      err "backend exited during startup; see $BACKEND_LOG"
      rm -f "$BACKEND_PID_FILE"
      return 1
    fi
    if curl -fsS "http://127.0.0.1:$BACKEND_PORT/api/v1/health/live" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.2
  done
  if [[ "$ready" -ne 1 ]]; then
    warn "backend started (pid $new_pid) but did not become ready in time; see $BACKEND_LOG"
  else
    ok "backend ready (pid $new_pid) at http://127.0.0.1:$BACKEND_PORT"
  fi
}

start_frontend() {
  local pid; pid="$(read_pid "$FRONTEND_PID_FILE")"
  if [[ -n "$pid" ]]; then
    ok "frontend already running (pid $pid) at http://127.0.0.1:$VITE_PORT"
    return
  fi
  if [[ ! -d "$ROOT_DIR/frontend/node_modules" ]]; then
    info "installing frontend dependencies…"
    (cd "$ROOT_DIR/frontend" && npm install)
  fi
  info "starting Vite dev server on http://127.0.0.1:$VITE_PORT …"
  echo "$VITE_PORT" >"$VITE_PORT_FILE"
  # --port selects the dev port; --host keeps it reachable from other devices.
  # VITE_BACKEND_URL points the dev proxy at the backend started above so a
  # non-default --port keeps the API proxy working.
  VITE_BACKEND_URL="http://127.0.0.1:$BACKEND_PORT" \
    nohup npm --prefix "$ROOT_DIR/frontend" run dev -- --port "$VITE_PORT" --host \
    >"$FRONTEND_LOG" 2>&1 &
  local new_pid=$!
  echo "$new_pid" >"$FRONTEND_PID_FILE"
  sleep 0.6
  if pid_alive "$new_pid"; then
    ok "frontend started (pid $new_pid) at http://127.0.0.1:$VITE_PORT"
  else
    err "frontend failed to start; see $FRONTEND_LOG"
    rm -f "$FRONTEND_PID_FILE"
    return 1
  fi
}

print_status() {
  local b f m
  b="$(read_pid "$BACKEND_PID_FILE")"
  f="$(read_pid "$FRONTEND_PID_FILE")"
  m="$(read_pid "$MOCK_PID_FILE")"
  local bport vport
  bport="$(cat "$PORT_FILE" 2>/dev/null || echo "$DEFAULT_BACKEND_PORT")"
  vport="$(cat "$VITE_PORT_FILE" 2>/dev/null || echo "$DEFAULT_VITE_PORT")"
  printf '%-10s %-8s %s\n' "SERVICE" "PID" "URL"
  if [[ -n "$b" ]]; then
    printf '%-10s %-8s http://127.0.0.1:%s\n' "backend" "$b" "$bport"
  else
    printf '%-10s %-8s %s\n' "backend" "-" "not running"
  fi
  if [[ -n "$f" ]]; then
    printf '%-10s %-8s http://127.0.0.1:%s\n' "frontend" "$f" "$vport"
  else
    printf '%-10s %-8s %s\n' "frontend" "-" "not running"
  fi
  if [[ -n "$m" ]]; then
    printf '%-10s %-8s http://%s:%s/v1\n' "mock" "$m" "$MOCK_HOST" "$MOCK_PORT"
  else
    printf '%-10s %-8s %s\n' "mock" "-" "not running"
  fi
}

tail_logs() {
  local svc="${1:-}"
  case "$svc" in
    backend)  exec tail -n 100 -f "$BACKEND_LOG" ;;
    frontend) exec tail -n 100 -f "$FRONTEND_LOG" ;;
    mock)     exec tail -n 100 -f "$MOCK_LOG" ;;
    "")       exec tail -n 100 -f "$BACKEND_LOG" "$FRONTEND_LOG" "$MOCK_LOG" ;;
    *) err "unknown service: $svc (use backend|frontend|mock)"; exit 2 ;;
  esac
}

usage() {
  sed -n '3,26p' "$0" | sed 's/^# \{0,1\}//'
}

parse_flags() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --no-mock)     USE_MOCK=0; shift ;;
      --no-frontend) START_FRONTEND=0; shift ;;
      --no-backend)  START_BACKEND=0; shift ;;
      --release)     RELEASE=1; shift ;;
      --port)        BACKEND_PORT="${2:?--port requires a value}"; shift 2 ;;
      --vite-port)   VITE_PORT="${2:?--vite-port requires a value}"; shift 2 ;;
      -h|--help)     usage; exit 0 ;;
      *) err "unknown flag: $1"; usage; exit 2 ;;
    esac
  done
}

main() {
  local cmd="${1:-start}"
  case "$cmd" in
    start)   shift || true; parse_flags "$@"; do_start ;;
    stop)    stop_all ;;
    restart) stop_all; shift || true; parse_flags "$@"; do_start ;;
    status)  print_status ;;
    logs)    shift || true; tail_logs "${1:-}" ;;
    -h|--help|help) usage ;;
    *) err "unknown command: $cmd"; usage; exit 2 ;;
  esac
}

do_start() {
  info "project root: $ROOT_DIR"
  if [[ "$START_BACKEND" -eq 1 && "$USE_MOCK" -eq 1 ]]; then
    start_mock || true
  fi
  if [[ "$START_BACKEND" -eq 1 ]]; then
    start_backend || true
  fi
  if [[ "$START_FRONTEND" -eq 1 ]]; then
    start_frontend || true
  fi
  echo
  print_status
  echo
  if [[ "$START_FRONTEND" -eq 1 ]]; then
    info "open the app at http://127.0.0.1:$VITE_PORT (login token: test)"
  elif [[ "$START_BACKEND" -eq 1 ]]; then
    info "open the app at http://127.0.0.1:$BACKEND_PORT (login token: test)"
  fi
  info "stop with: ./scripts/dev.sh stop"
}

main "$@"
