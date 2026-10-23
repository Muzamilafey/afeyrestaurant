@echo off
rem Double-click to install Chili POS on this PC. Windows asks for administrator rights.
rem Same as: powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-NoExit','-File','\"%~dp0scripts\windows\install.ps1\"'"
