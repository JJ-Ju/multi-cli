@echo off
setlocal enabledelayedexpansion

REM Launch the multi-provider Ionesco CLI with the correct environment.

set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%.."
set "SIDECAR_DIR=%REPO_ROOT%\providers\grok_sidecar"
set "VENV_DIR=%SIDECAR_DIR%\.venv"
set "VENV_PY=%VENV_DIR%\Scripts\python.exe"

if not exist "%REPO_ROOT%\node_modules" (
  echo Error: node_modules not found. Run scripts\setup.bat first.
  exit /b 1
)
if not exist "%VENV_PY%" (
  echo Error: Grok sidecar virtualenv missing. Run scripts\setup.bat first.
  exit /b 1
)

if "%GROK_PYTHON_BIN%"=="" (
  set "GROK_PYTHON_BIN=%VENV_PY%"
  echo [start] Using Grok Python runtime: %GROK_PYTHON_BIN%
)

call :load_env "%REPO_ROOT%\.env"
call :load_env "%SIDECAR_DIR%\.env"

pushd "%REPO_ROOT%"
  echo [start] Starting CLI (npm run start)
  npm run start
popd
exit /b %errorlevel%

:load_env
  set "ENV_FILE=%~1"
  if not exist "%ENV_FILE%" goto :eof
  for /f "usebackq tokens=1* delims==" %%a in (`findstr /r "^[^#].*=.*" "%ENV_FILE%"`) do (
    if "!%%a!"=="" goto :continue
    if "!%%a!"=="GROK_PYTHON_BIN" goto :continue
    if not defined %%a (
      set "%%a=%%b"
    )
    :continue
  )
  goto :eof
