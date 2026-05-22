@echo off
cd /d "%~dp0"
echo MiniTalk 正在启动...
echo 主页: http://localhost:3000
echo 管理后台: http://localhost:3000/admin
echo 管理员账号: admin / admin123
echo.
node server/index.js
pause
