@echo off
chcp 65001 >nul
title Clash 流量报告
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0report.ps1" %*
echo.
echo 按任意键关闭此窗口。
pause >nul
