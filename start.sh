#!/usr/bin/env bash
set -euo pipefail

# Launch the multi-provider Ionesco CLI with the correct environment in place.

SCRIPT_SOURCE="${BASH_SOURCE[0]}"
SCRIPT_DIR="$(cd -- "$(dirname "$SCRIPT_SOURCE")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}"
SIDECAR_DIR="${REPO_ROOT}/providers/grok_sidecar"
VENV_DIR="${SIDECAR_DIR}/.venv"

log() {
  printf '[start] %s\n' "$1"
}

fail() {
  >&2 printf 'Error: %s\n' "$1"
  exit 1
}

# Ensure setup artifacts exist
if [[ ! -d "${REPO_ROOT}/node_modules" ]]; then
  fail "node_modules not found. Run ./setup.sh first."
fi

if [[ ! -d "${VENV_DIR}" ]]; then
  fail "Grok sidecar virtualenv missing. Run ./setup.sh first."
fi

VENV_PY="${VENV_DIR}/bin/python"
if [[ ! -x "${VENV_PY}" ]]; then
  fail "${VENV_PY} not found or not executable. Re-run ./setup.sh."
fi

# Export Grok-specific environment variables if available
if [[ -z "${GROK_PYTHON_BIN:-}" ]]; then
  export GROK_PYTHON_BIN="${VENV_PY}"
  log "Using Grok Python runtime: ${GROK_PYTHON_BIN}"
fi

load_env_file() {
  local file="$1"
  if [[ -f "${file}" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line%%#*}"
      line="${line%%$'\r'}"
      if [[ -z "$line" ]] || [[ "$line" != *=* ]]; then
        continue
      fi
      local key="${line%%=*}"
      local value="${line#*=}"
      if [[ -z "${!key:-}" ]]; then
        export "$key"="$value"
      fi
    done <"${file}"
  fi
}

# Load optional env files without overriding explicit exports
load_env_file "${REPO_ROOT}/.env"
load_env_file "${SIDECAR_DIR}/.env"

log "Starting CLI via scripts/start.js"

node "${REPO_ROOT}/scripts/start.js"
