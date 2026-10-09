#!/bin/sh
# EmitAI - teste local (Mac/Linux)
cd "$(dirname "$0")"
command -v docker >/dev/null || { echo "Instale e abra o Docker Desktop."; exit 1; }
if [ ! -f .env ]; then
  printf "Seu e-mail (administrador da plataforma): "; read EMAIL
  printf 'APP_NAME=EmitAI\nAPP_URL=http://127.0.0.1:3333\nNODE_ENV=development\nPOSTGRES_PASSWORD=teste-local-%s\nSUPERADMIN_EMAILS=%s\nTRIAL_DAYS=14\n' "$(date +%s)" "$EMAIL" > .env
fi
docker compose up -d --build && echo "Pronto: http://127.0.0.1:3333 (links de e-mail: docker compose logs app | grep entrar)"
