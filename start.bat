@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem 用法：start.bat          启动（默认，双击即可）
rem       start.bat status   查看状态
rem       start.bat restart  重启
rem       start.bat stop     停止

if /i "%~1"=="stop"    goto :cmd_stop
if /i "%~1"=="restart" goto :cmd_restart
if /i "%~1"=="status"  goto :cmd_status

echo ==========================================
echo   fuckds  一键启动
echo ==========================================

where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 Node.js，请先安装 Node.js 20.11+
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo [依赖] node_modules 不存在，执行 npm install ...
    call npm install
    if errorlevel 1 goto :fail
)

if not exist "bin\ds-pow.exe" (
    echo [PoW] bin\ds-pow.exe 不存在，执行 npm run pow:build（需要 Go 1.21+）...
    call npm run pow:build
    if errorlevel 1 goto :fail
)

rem 解析实际监听地址（.env 里改过 HOST/PORT 也能打开正确页面）
del "%TEMP%\fuckds-base.txt" >nul 2>nul
node --input-type=module -e "import { loadConfig } from './src/config.mjs'; const c = loadConfig(); const h = c.server.host === '0.0.0.0' ? '127.0.0.1' : c.server.host; console.log('http://' + h + ':' + c.server.port);" > "%TEMP%\fuckds-base.txt" 2>nul
if exist "%TEMP%\fuckds-base.txt" set /p BASE=<"%TEMP%\fuckds-base.txt"
del "%TEMP%\fuckds-base.txt" >nul 2>nul
if not defined BASE set "BASE=http://127.0.0.1:8787"

echo [启动] npm run up（后台运行，日志 data\server.log）
call npm run up
if errorlevel 1 goto :fail

echo.
echo   控制台   %BASE%/admin
echo   接口     %BASE%/v1/chat/completions
echo   状态     start.bat status
echo   重启     start.bat restart
echo   停止     start.bat stop
echo.

if exist "web\dist\" start "" "%BASE%/admin"
pause
exit /b 0

:cmd_status
call npm run status
pause
exit /b 0

:cmd_stop
call npm run down
pause
exit /b 0

:cmd_restart
call npm run restart
if errorlevel 1 goto :fail
pause
exit /b 0

:fail
echo.
if exist "data\server.log" (
    echo [日志] data\server.log 最后 20 行：
    powershell -NoProfile -Command "Get-Content -Tail 20 -LiteralPath 'data\server.log'"
)
echo.
echo 启动失败，请检查上面的日志输出。
pause
exit /b 1
