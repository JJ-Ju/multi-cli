#!/usr/bin/env bash
set -euo pipefail

# bootstrap multi-provider Gemini CLI workspace (Node + Grok sidecar Python deps)

SCRIPT_SOURCE="${BASH_SOURCE[0]}"
SCRIPT_DIR="$(cd -- "$(dirname "$SCRIPT_SOURCE")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
SIDECAR_DIR="${REPO_ROOT}/providers/grok_sidecar"
VENV_DIR="${SIDECAR_DIR}/.venv"
REQ_FILE="${SIDECAR_DIR}/requirements.txt"

log() {
  printf '[setup] %s\n' "$1"
}

fail() {
  >&2 printf 'Error: %s\n' "$1"
  exit 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "$1 is required but was not found in PATH."
  fi
}

# ---------------------------------------------------------------------------
# Detect tooling
# ---------------------------------------------------------------------------
require_command npm
require_command node

PYTHON=${PYTHON:-}
if [[ -n "${PYTHON}" ]] && command -v "${PYTHON}" >/dev/null 2>&1; then
  PY_CMD="${PYTHON}"
else
  PY_CMD=""
  for candidate in python3 python; do
    if command -v "${candidate}" >/dev/null 2>&1; then
      PY_CMD="${candidate}"
      break
    fi
  done
fi

if [[ -z "${PY_CMD}" ]]; then
  fail "Python 3.10+ is required but was not found."
fi

PY_VERSION_STR=$("${PY_CMD}" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
PY_MAJOR=${PY_VERSION_STR%%.*}
PY_MINOR=${PY_VERSION_STR#*.}
if (( PY_MAJOR < 3 || (PY_MAJOR == 3 && PY_MINOR < 10) )); then
  fail "Detected Python ${PY_VERSION_STR}. Python 3.10 or newer is required."
fi

log "Using Python interpreter: ${PY_CMD} (${PY_VERSION_STR})"

# ---------------------------------------------------------------------------
# Install Node dependencies (workspace aware)
# ---------------------------------------------------------------------------
log "Installing Node dependencies via npm install..."
(cd "${REPO_ROOT}" && npm install)

# ---------------------------------------------------------------------------
# Build the Node workspaces so the CLI can start immediately
# ---------------------------------------------------------------------------
log "Building workspace artifacts (npm run build)..."
(cd "${REPO_ROOT}" && npm run build)

# ---------------------------------------------------------------------------
# Prepare Grok sidecar virtual environment
# ---------------------------------------------------------------------------
if [[ ! -d "${VENV_DIR}" ]]; then
  log "Creating Python virtual environment at providers/grok_sidecar/.venv"
  "${PY_CMD}" -m venv "${VENV_DIR}"
else
  log "Reusing existing virtual environment at providers/grok_sidecar/.venv"
fi

VENV_PY="${VENV_DIR}/bin/python"
VENV_PIP="${VENV_DIR}/bin/pip"
if [[ ! -x "${VENV_PY}" ]]; then
  fail "Virtual environment looks corrupt (missing ${VENV_PY}). Delete the directory and rerun."
fi

log "Upgrading pip and build tooling inside the virtual environment"
"${VENV_PY}" -m pip install --upgrade pip setuptools wheel >/dev/null

if [[ -f "${REQ_FILE}" ]]; then
  log "Installing Grok sidecar dependencies from requirements.txt"
  "${VENV_PIP}" install -r "${REQ_FILE}"
else
  log "requirements.txt not found; installing base dependencies"
  "${VENV_PIP}" install xai-sdk protobuf
fi

# ---------------------------------------------------------------------------
# Ensure per-provider env template exists
# ---------------------------------------------------------------------------
if [[ ! -f "${SIDECAR_DIR}/.env" ]] && [[ -f "${SIDECAR_DIR}/.env.example" ]]; then
  log "Copying providers/grok_sidecar/.env.example to .env (fill in your secrets)"
  cp "${SIDECAR_DIR}/.env.example" "${SIDECAR_DIR}/.env"
fi

log "Setup complete. Activate the sidecar environment with:"
log "  source providers/grok_sidecar/.venv/bin/activate"
log "and run the CLI via npm scripts as needed."
