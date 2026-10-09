@echo off
cd /d "%~dp0"
docker compose stop
echo  Sistema desligado. Seus dados continuam guardados; rode TESTAR.bat para ligar de novo.
pause
