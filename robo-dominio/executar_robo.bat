@echo off
REM Executa o ciclo completo para a competencia anterior.
REM Agende no Agendador de Tarefas do Windows (ex.: diariamente as 07:00), com o usuario logado
REM (RPA precisa de sessao de desktop ativa e desbloqueada).
cd /d "%~dp0"
if not exist logs mkdir logs
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmm"') do set DATA=%%i
python -m robo_dominio ciclo %* >> "logs\robo_%DATA%.log" 2>&1
