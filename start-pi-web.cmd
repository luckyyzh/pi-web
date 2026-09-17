@echo off
setlocal
chcp 65001 >nul

REM 参数入口：帮助和参数错误必须在安装、构建以及端口操作之前处理。
cd /d "%~dp0"
set "PI_WEB_MODE=ensure"
set "PI_WEB_AUTO=0"
set "PI_WEB_PORT=%PORT%"
set "PI_WEB_INSTANCE=%~2"
if not "%~3"=="" goto invalid
if /i "%~1"=="help" goto help
if /i "%~1"=="--help" goto help
if /i "%~1"=="-h" goto help
if /i "%~1"=="/?" goto help
if /i "%~1"=="update" goto update-args
if /i "%~1"=="next" goto next-args
if not "%~1"=="" set "PI_WEB_PORT=%~1"
goto args-ready
:update-args
set "PI_WEB_MODE=update"
goto args-ready
:next-args
set "PI_WEB_AUTO=1"
:args-ready
if not defined PI_WEB_PORT set "PI_WEB_PORT=30141"

REM 检查 Node.js；使用环境变量校验参数，避免将参数插入 JavaScript。
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 22+ first: https://nodejs.org
  exit /b 1
)
node -e "const [m,n]=process.versions.node.split('.').map(Number);process.exit(m<22||(m===22&&n<19)?1:0)" >nul 2>&1
if errorlevel 1 (
  echo [ERROR] pi-web requires Node.js 22.19 or newer.
  exit /b 1
)
node -e "const e=process.env;const name=e.PI_WEB_INSTANCE||'';const port=e.PI_WEB_PORT;const validName=!name||(/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u.test(name)&&!/[ .]$/.test(name)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name));const validPort=e.PI_WEB_MODE==='update'||e.PI_WEB_AUTO==='1'||(/^[0-9]{1,5}$/.test(port)&&Number(port)>=1&&Number(port)<=65535);process.exit(validName&&validPort?0:1)"
if errorlevel 1 goto invalid

REM 默认保留用户现有 PI_CODING_AGENT_DIR；指定实例名才覆盖为隔离目录。
if not defined PI_WEB_INSTANCE goto after-instance
set "PI_CODING_AGENT_DIR=%USERPROFILE%\.pi\pi-web-instances\%PI_WEB_INSTANCE%"
if exist "%PI_CODING_AGENT_DIR%" goto instance-exists
mkdir "%PI_CODING_AGENT_DIR%"
if errorlevel 1 exit /b 1
echo [..] NOTE: new isolated instance - configure models/api key in ModelsConfig first.
:instance-exists
echo [..] Isolated data dir: %PI_CODING_AGENT_DIR%
:after-instance

REM 项目位于用户主目录时提示构建风险，不删除或迁移用户数据。
if /i not "%CD%"=="%USERPROFILE%" goto after-warn
echo [WARN] Project root equals the user home directory.
echo        next build may fail when scanning Windows junction directories.
echo        Move the project to a dedicated folder, e.g. C:\pi-web.
:after-warn

REM 普通启动保留全局 Pi CLI 检查；更新扩展仅使用项目 SDK。
if /i "%PI_WEB_MODE%"=="update" goto dependencies
REM 检查并按需安装全局 Pi CLI。
echo [1/4] Checking pi coding agent...
where pi >nul 2>&1
if errorlevel 1 (
  echo [..] pi agent not found. Installing @earendil-works/pi-coding-agent globally...
  call npm install -g @earendil-works/pi-coding-agent
  if errorlevel 1 (
    echo [ERROR] Failed to install the pi coding agent. Try: npm install -g @earendil-works/pi-coding-agent
    if /i not "%PI_WEB_MODE%"=="update" pause
    exit /b 1
  )
  echo [OK] pi agent installed.
) else (
  echo [OK] pi agent already installed.
  call pi --version
)

:dependencies
REM 检查项目依赖，缺失时沿用 npm install 流程。
echo [2/4] Checking pi-web dependencies...
if not exist "node_modules\@earendil-works\pi-coding-agent" (
  echo [..] Installing pi-web dependencies...
  call npm install --include=dev
  if errorlevel 1 (
    echo [ERROR] Failed to install pi-web dependencies.
    if /i not "%PI_WEB_MODE%"=="update" pause
    exit /b 1
  )
  echo [OK] pi-web dependencies installed.
) else (
  echo [OK] pi-web dependencies present.
)

REM 实例环境和项目依赖就绪后同步扩展；失败必须退出，禁止继续启动。
node "%~dp0bin\sync-pi-extensions.js" %PI_WEB_MODE%
if errorlevel 1 exit /b 1
REM 显式更新到此结束，不构建、不探测端口、不操作服务，也不暂停。
if /i "%PI_WEB_MODE%"=="update" exit /b 0

REM 普通启动继续检查和构建产物。
echo [3/4] Checking build artifacts...
if not exist ".next\BUILD_ID" (
  echo [..] Building pi-web...
  call npm run build
  if errorlevel 1 (
    echo [ERROR] Build failed.
    if /i not "%PI_WEB_MODE%"=="update" pause
    exit /b 1
  )
  if not exist ".next\BUILD_ID" (
    echo [ERROR] Build finished but .next\BUILD_ID is missing - the build worker
    echo        probably crashed. Retry, or free memory / enlarge the page file.
    if /i not "%PI_WEB_MODE%"=="update" pause
    exit /b 1
  )
  echo [OK] Build complete.
) else (
  echo [OK] Build artifacts present.
)

REM 保持原有端口行为：自动选择空闲端口，指定端口释放占用。
if "%PI_WEB_AUTO%"=="1" goto port-auto
goto port-check

:port-auto
REM 自动模式在原有范围内寻找空闲端口，不终止其它实例。
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
REM 指定端口模式沿用旧行为，终止该端口上的旧进程。
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

REM 启动服务，退出后保留窗口方便查看日志。
echo [4/4] Starting pi-web...
echo Pi Web will be available at http://127.0.0.1:%PORT%
node "%~dp0bin\pi-web.js" -p %PORT%
pause
exit /b %errorlevel%

REM 帮助和错误出口不执行安装、构建、扩展同步或端口操作。
:help
if not "%~2"=="" goto invalid
echo Usage: start-pi-web.cmd [port^|next] [instance-name]
echo        start-pi-web.cmd update [instance-name]
echo        start-pi-web.cmd help
echo.
echo Default: PORT environment variable or 30141; explicit ports restart the old instance.
echo next: first free port in 30141-30199; never stops another instance.
echo update: update extensions only; no build, server or port operations.
echo         Does not update pi-web or the global Pi CLI.
echo instance-name: 1-64 letters, digits, spaces, dots, underscores or hyphens;
echo                supports Chinese; starts with a letter or digit; no reserved names.
echo Named instances use USERPROFILE\.pi\pi-web-instances\name.
echo Without a name, the existing PI_CODING_AGENT_DIR is preserved.
exit /b 0
:invalid
echo [ERROR] Invalid arguments. Run start-pi-web.cmd help for usage.
exit /b 2