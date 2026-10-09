@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  Links enviados por e-mail (sem servidor de e-mail, eles aparecem aqui):
echo.
docker compose logs app | findstr /i "http://127.0.0.1:3333/entrar"
echo.
echo  Copie o link desejado e cole no navegador.
pause
