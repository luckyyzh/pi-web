@echo off
setlocal
cd /d "%~dp0"

REM ---- Warn if the project root is the user home dir (Windows junction EPERM) ----
if /i "%CD%"=="%USERPROFILE%" (
  echo [WARN] Project root equals the user home directory (%USERPROFILE%).
  echo        next build will scan Windows junction dirs in it
  echo        ^(Application Data, Local Settings, My Documents, ...^) and can
  echo        fail with "EPERM: operation not permitted, scandir ...".
  echo        Move the project to a dedicated folder, e.g.
  echo          %USERPROFILE%\Documents\pi-web   or   C:\pi-web
  echo        then re-run this script.
  echo.
)

REM ============================================================
REM  Pi Web - one-click launcher
REM  - Ensures Node.js and the pi coding agent are installed
REM  - Ensures pi-web dependencies are installed
REM  - Builds if artifacts are missing
REM  - Starts pi-web
REM  NOTE: ASCII only on purpose. Chinese comments break cmd.exe
REM        encoding on zh-CN systems and the script misfires.
REM ============================================================

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
  echo [OK] Build complete.
) else (
  echo [OK] Build artifacts present.
)

REM ---- 4. Port: free it if occupied (stops the previous pi-web instance) ----
if not defined PORT set PORT=30141
netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul 2>&1
if not errorlevel 1 (
  echo [WARN] Port %PORT% already in use. Stopping the process holding it...
  for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING') do (
    echo [..] Killing PID %%p ...
    taskkill /F /PID %%p >nul 2>&1
  )
  ping -n 2 127.0.0.1 >nul
)

REM ---- 5. Start pi-web ----
echo [4/4] Starting pi-web...
echo Pi Web will be available at http://127.0.0.1:%PORT%
node "%~dp0bin\pi-web.js" -p %PORT%
pause
