@echo off
setlocal
cd /d "%~dp0"

REM ---- Warn if the project root is the user home dir (Windows junction EPERM) ----
if /i "%CD%"=="%USERPROFILE%" goto warn-home
REM (no paren-block, avoids cmd parse errors)
goto after-warn
:warn-home
echo [WARN] Project root equals the user home directory.
echo        next build will scan Windows junction dirs in it
echo        ^(Application Data, Local Settings, My Documents, ...^) and can
echo        fail with "EPERM: operation not permitted, scandir ...".
echo        Move the project to a dedicated folder, e.g.
echo          %USERPROFILE%\Documents\pi-web  or  C:\pi-web
echo        then re-run this script.
echo.
:after-warn

REM ============================================================
REM  Pi Web - one-click launcher (multi-instance capable)
REM  - Ensures Node.js and the pi coding agent are installed
REM  - Ensures pi-web dependencies are installed
REM  - Builds if artifacts are missing
REM  - Starts pi-web on the requested port
REM
REM  Usage (run once per window to open multiple instances):
REM    start-pi-web.cmd                 -> port 30141 (kills stale process if busy)
REM    start-pi-web.cmd 30200           -> port 30200 (kills stale process if busy)
REM    start-pi-web.cmd next            -> first free port >= 30141, never kills
REM    start-pi-web.cmd 30200 MyAgent   -> port 30200 with ISOLATED data dir
REM                                        ~/.pi/pi-web-instances\MyAgent
REM                                        (own sessions/models/auth; starts empty)
REM  NOTE: ASCII only on purpose. Chinese comments break cmd.exe
REM        encoding on zh-CN systems and the script misfires.
REM ============================================================

REM ---- Parse args: [port|next] [instance-name] ----
set "PI_WEB_PORT=%PORT%"
set "PI_WEB_AUTO=0"
set "PI_WEB_INSTANCE="
if not "%~1"=="" (
  if /i "%~1"=="next" (
    set "PI_WEB_AUTO=1"
  ) else (
    set "PI_WEB_PORT=%~1"
  )
)
if not defined PI_WEB_PORT set "PI_WEB_PORT=30141"
if not "%~2"=="" set "PI_WEB_INSTANCE=%~2"

REM ---- Optional isolated data dir per instance (own sessions/models/auth) ----
REM (label-based on purpose: %VAR% reads inside a paren block are expanded
REM  before the set runs, which would yield an empty path)
if not defined PI_WEB_INSTANCE goto after-instance
set "PI_CODING_AGENT_DIR=%USERPROFILE%\.pi\pi-web-instances\%PI_WEB_INSTANCE%"
if exist "%PI_CODING_AGENT_DIR%" goto instance-exists
mkdir "%PI_CODING_AGENT_DIR%"
echo [..] NOTE: new isolated instance - configure models/api key in ModelsConfig first.
:instance-exists
echo [..] Isolated data dir: %PI_CODING_AGENT_DIR%
:after-instance

REM ---- 0. Check Node.js ----
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 22+ first: https://nodejs.org
  pause
  exit /b 1
)
node -e "const [m,n]=process.versions.node.split('.').map(Number);process.exit(m<22||(m===22&&n<19)?1:0)" >nul 2>&1
if errorlevel 1 (
  echo [ERROR] pi-web requires Node.js 22.19 or newer. Current:
  node --version
  echo        Install Node.js 22 LTS or newer: https://nodejs.org
  pause
  exit /b 1
)

REM ---- 1. Check / install pi coding agent (global CLI) ----
echo [1/4] Checking pi coding agent...
where pi >nul 2>&1
if errorlevel 1 (
  echo [..] pi agent not found. Installing @earendil-works/pi-coding-agent globally...
  call npm install -g @earendil-works/pi-coding-agent
  if errorlevel 1 (
    echo [ERROR] Failed to install the pi coding agent. Try: npm install -g @earendil-works/pi-coding-agent
    pause
    exit /b 1
  )
  echo [OK] pi agent installed.
) else (
  echo [OK] pi agent already installed.
  call pi --version
)

REM ---- 2. Check / install pi-web dependencies ----
echo [2/4] Checking pi-web dependencies...
if not exist "node_modules\@earendil-works\pi-coding-agent" (
  echo [..] Installing pi-web dependencies...
  call npm install --include=dev
  if errorlevel 1 (
    echo [ERROR] Failed to install pi-web dependencies.
    pause
    exit /b 1
  )
  echo [OK] pi-web dependencies installed.
) else (
  echo [OK] pi-web dependencies present.
)

REM ---- 3. Ensure build artifacts ----
echo [3/4] Checking build artifacts...
if not exist ".next\BUILD_ID" (
  echo [..] Building pi-web...
  call npm run build
  if errorlevel 1 (
    echo [ERROR] Build failed.
    pause
    exit /b 1
  )
  if not exist ".next\BUILD_ID" (
    echo [ERROR] Build finished but .next\BUILD_ID is missing - the build worker
    echo        probably crashed. Retry, or free memory / enlarge the page file.
    pause
    exit /b 1
  )
  echo [OK] Build complete.
) else (
  echo [OK] Build artifacts present.
)

REM ---- 4. Port: resolve, free it if needed ----
if "%PI_WEB_AUTO%"=="1" goto port-auto
goto port-check

:port-auto
REM Auto mode: first free port >= 30141. Never kills other instances.
echo [..] Scanning for a free port in 30141-30199...
netstat -ano | findstr LISTENING > "%TEMP%\piweb-netstat.txt"
set "PORT="
for /l %%p in (30141,1,30199) do (
  findstr /C:":%%p " "%TEMP%\piweb-netstat.txt" >nul 2>&1
  if errorlevel 1 (
    if not defined PORT set "PORT=%%p"
  )
)
del "%TEMP%\piweb-netstat.txt" 2>nul
if not defined PORT (
  echo [ERROR] No free port found in 30141-30199. Close some instances and retry.
  pause
  exit /b 1
)
goto port-done

:port-check
REM Explicit port: free it if occupied (restarts the previous instance on it).
set "PORT=%PI_WEB_PORT%"
netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul 2>&1
if not errorlevel 1 (
  echo [WARN] Port %PORT% already in use. Stopping the process holding it...
  for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING') do (
    echo [..] Killing PID %%p ...
    taskkill /F /PID %%p >nul 2>&1
  )
  ping -n 2 127.0.0.1 >nul
)
:port-done

REM ---- 5. Start pi-web ----
echo [4/4] Starting pi-web...
echo Pi Web will be available at http://127.0.0.1:%PORT%
node "%~dp0bin\pi-web.js" -p %PORT%
pause
