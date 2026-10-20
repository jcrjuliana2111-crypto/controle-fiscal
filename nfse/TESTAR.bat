@echo off
chcp 65001 >nul
title EmitAI - teste no computador
cd /d "%~dp0"
echo.
echo  ==========================================
echo    EmitAI - preparando o teste local
echo  ==========================================
echo.
echo  [1/3] Procurando o Docker Desktop...
where docker >nul 2>nul
if errorlevel 1 (
  echo.
  echo  O Docker Desktop nao foi encontrado.
  echo  Instale em https://www.docker.com/products/docker-desktop e abra o programa antes.
  pause
  exit /b 1
)
echo  [2/3] Verificando se o Docker Desktop esta pronto (ate 1 minuto)...
powershell -NoProfile -Command "$j = Start-Job { docker info *> $null; $LASTEXITCODE }; if (Wait-Job $j -Timeout 60) { $c = Receive-Job $j; if ($c -eq 0) { exit 0 } else { exit 1 } } else { Stop-Job $j; exit 2 }"
if errorlevel 2 (
  echo.
  echo  O Docker Desktop nao respondeu.
  echo  Abra o Docker Desktop e espere aparecer "Engine running" ^(canto inferior esquerdo^).
  echo  Na primeira vez ele pode pedir para aceitar os termos ou reiniciar o computador.
  echo  Depois rode este arquivo de novo.
  pause
  exit /b 1
)
if errorlevel 1 (
  echo.
  echo  O Docker Desktop esta instalado, mas nao esta ligado.
  echo  Abra o Docker Desktop, espere aparecer "Engine running" e rode este arquivo de novo.
  pause
  exit /b 1
)
echo  [3/3] Docker pronto.
if not exist ".env" (
  set /p EMAIL=" Digite o seu e-mail (sera o administrador da plataforma): "
  call :criarenv
)
echo.
echo  Subindo o sistema (na primeira vez demora alguns minutos)...
docker compose up -d --build
if errorlevel 1 (
  echo  Algo deu errado ao subir. Copie a mensagem acima e mande para o suporte.
  pause
  exit /b 1
)
echo.
echo  Pronto! Abrindo http://127.0.0.1:3333
timeout /t 5 >nul
start "" http://127.0.0.1:3333
echo.
echo  Para ver os links de confirmacao de e-mail, rode VER-LINKS.bat
echo  Para desligar, rode DESLIGAR.bat
pause
exit /b 0

:criarenv
(
  echo APP_NAME=EmitAI
  echo APP_URL=http://127.0.0.1:3333
  echo NODE_ENV=development
  echo POSTGRES_PASSWORD=teste-local-%RANDOM%%RANDOM%
  echo SUPERADMIN_EMAILS=%EMAIL%
  echo TRIAL_DAYS=14
) > .env
exit /b 0
