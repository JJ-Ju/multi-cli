@echo off
setlocal enabledelayedexpansion

REM Bootstrap multi-provider Gemini CLI workspace (Node + Grok sidecar Python deps)

set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%.."
set "SIDECAR_DIR=%REPO_ROOT%\providers\grok_sidecar"
set "VENV_DIR=%SIDECAR_DIR%\.venv"
set "REQ_FILE=%SIDECAR_DIR%\requirements.txt"

call :log "Ensuring prerequisites"
where npm >nul 2>nul || (echo Error: npm is required but not found.& exit /b 1)
where node >nul 2>nul || (echo Error: node is required but not found.& exit /b 1)

set "PY_CMD=%PYTHON%"
if "%PY_CMD%"=="" (
  where python3 >nul 2>nul && set "PY_CMD=python3"
)
if "%PY_CMD%"=="" (
  where python >nul 2>nul && set "PY_CMD=python"
)
if "%PY_CMD%"=="" (
  echo Error: Python 3.10+ is required but was not found.
  exit /b 1
)

for /f "usebackq tokens=1,2 delims=." %%a in (`%PY_CMD% -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"`) do (
  set "PY_MAJOR=%%a"
  set "PY_MINOR=%%b"
)
if %PY_MAJOR% LSS 3 (
  echo Error: Python 3.10 or newer is required.
  exit /b 1
)
if %PY_MAJOR% EQU 3 if %PY_MINOR% LSS 10 (
  echo Error: Python 3.10 or newer is required.
  exit /b 1
)

call :log "Using Python interpreter: %PY_CMD%"

call :log "Installing Node dependencies via npm install..."
pushd "%REPO_ROOT%"
npm install || exit /b 1

call :log "Building workspace artifacts (npm run build)..."
npm run build || exit /b 1
popd

if not exist "%VENV_DIR%" (
  call :log "Creating Python virtual environment at providers\grok_sidecar\.venv"
  %PY_CMD% -m venv "%VENV_DIR%" || exit /b 1
) else (
  call :log "Reusing existing virtual environment at providers\grok_sidecar\.venv"
)

set "VENV_PY=%VENV_DIR%\Scripts\python.exe"
set "VENV_PIP=%VENV_DIR%\Scripts\pip.exe"
if not exist "%VENV_PY%" (
  echo Error: Virtual environment looks corrupt (missing %VENV_PY%). Delete the directory and rerun.
  exit /b 1
)

call :log "Upgrading pip and build tooling inside the virtual environment"
"%VENV_PY%" -m pip install --upgrade pip setuptools wheel >nul || exit /b 1

if exist "%REQ_FILE%" (
  call :log "Installing Grok sidecar dependencies from requirements.txt"
  "%VENV_PIP%" install -r "%REQ_FILE%" || exit /b 1
) else (
  call :log "requirements.txt not found; installing base dependencies"
  "%VENV_PIP%" install xai-sdk protobuf || exit /b 1
)

if not exist "%SIDECAR_DIR%\.env" if exist "%SIDECAR_DIR%\.env.example" (
  call :log "Copying providers\grok_sidecar\.env.example to .env (fill in your secrets)"
  copy "%SIDECAR_DIR%\.env.example" "%SIDECAR_DIR%\.env" >nul
)

call :log "Setup complete. Activate with:"
call :log "  call %SIDECAR_DIR%\.venv\Scripts\activate"
call :log "and run the CLI via scripts\start.bat"
exit /b 0

:log
  echo [setup] %~1
  goto :eof
