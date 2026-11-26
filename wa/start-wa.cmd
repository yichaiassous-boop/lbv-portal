@echo off
chcp 65001 >nul
title LBV WhatsApp
cd /d "%~dp0"
echo WhatsApp link is running. Keep this window open (you can minimize it).
"C:\Users\yicha\AppData\Local\node-portable\node-v24.19.0-win-x64\node.exe" --env-file=.env index.js
echo.
echo Stopped. Press any key to close.
pause >nul
