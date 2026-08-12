@echo off
setlocal
cd /d "%~dp0"

REM ============================================================
REM  Sync upstream agegr/pi-web into local main
REM  - Fetches origin (upstream), reports ahead/behind
REM  - Merges origin/main if there is anything new
REM  - Does NOT build and does NOT push -- you decide when.
REM  NOTE: ASCII only on purpose (cmd encoding).
REM ============================================================

git remote get-url origin >nul 2>&1
if errorlevel 1 (
  echo [ERROR] No "origin" remote. Add upstream first:
  echo        git remote add origin https://github.com/agegr/pi-web.git
  pause
  exit /b 1
)

echo [1/3] Fetching upstream ^(origin^)...
git fetch origin
if errorlevel 1 (
  echo [ERROR] Fetch failed. Check your network / proxy.
  pause
  exit /b 1
)

REM ---- Ensure README always keeps the fork version on merge ----
git config merge.ours.driver true

REM ---- Count ahead/behind vs origin/main ----
for /f "tokens=1,2" %%x in ('git rev-list --left-right --count main...origin/main') do (
  set LOCAL=%%x
  set REMOTE=%%y
)

echo [2/3] main is %LOCAL% ahead, %REMOTE% behind origin/main.

if "%REMOTE%"=="0" (
  echo [OK] main already contains everything from origin/main. Nothing to merge.
  pause
  exit /b 0
)

echo [3/3] Merging origin/main into main...
git merge origin/main --no-edit
if errorlevel 1 (
  echo.
  echo [WARN] Merge stopped due to conflicts. Resolve them, then:
  echo        git add ^<resolved files^>
  echo        git commit
  echo        call npm run build
  pause
  exit /b 1
)

echo.
echo [OK] Merge complete. Latest history:
git log --oneline -5

echo.
echo Next steps ^(you choose when to do them^):
echo   - Rebuild  : call npm run build   ^(then restart pi-web^)
echo   - Push     : git push luckyyzh main
pause
