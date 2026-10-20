#!/usr/bin/env bash
# Instala o EmitAI num servidor Ubuntu (VPS) com HTTPS automático.
# Rode como root no terminal do servidor:
#   curl -fsSL https://raw.githubusercontent.com/jcrjuliana2111-crypto/controle-fiscal/claude/peaceful-knuth-u6sfq3/nfse/instalar-vps.sh | bash
# Pode rodar de novo a qualquer momento: atualiza o código e mantém os dados e o .env.
set -euo pipefail

REPO="${REPO:-https://github.com/jcrjuliana2111-crypto/controle-fiscal.git}"
BRANCH="${BRANCH:-claude/peaceful-knuth-u6sfq3}"
DESTINO="${DESTINO:-/opt/emitai}"
PASTA="$DESTINO/nfse"
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.vps.yml"

passo() { printf '\n\033[1;34m[%s]\033[0m %s\n' "$1" "$2"; }
perguntar() { local r; read -r -p "$1" r </dev/tty; printf '%s' "$r"; }

[ "$(id -u)" -eq 0 ] || { echo "Rode como root (ou com sudo)."; exit 1; }

echo "=============================================="
echo "   Instalação do EmitAI no servidor"
echo "=============================================="

passo 1/6 "Instalando o básico (git, curl, openssl)..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl openssl ca-certificates >/dev/null

passo 2/6 "Instalando o Docker..."
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null

passo 3/6 "Baixando o código do EmitAI..."
if [ -d "$DESTINO/.git" ]; then
  git -C "$DESTINO" fetch -q origin "$BRANCH"
  git -C "$DESTINO" checkout -q -B "$BRANCH" "origin/$BRANCH"
else
  git clone -q --branch "$BRANCH" "$REPO" "$DESTINO"
fi
cd "$PASTA"

passo 4/6 "Configurando..."
if [ ! -f .env ]; then
  IP="$(curl -fsS4 https://api.ipify.org || hostname -I | awk '{print $1}')"
  echo "Endereço do servidor: $IP"
  echo
  echo "Tem um domínio apontado para este servidor (ex.: app.emitai.com.br)?"
  echo "Se ainda não tem, só aperte Enter: vou usar um endereço provisório gratuito."
  DOMINIO="$(perguntar 'Domínio: ')"
  [ -n "$DOMINIO" ] || DOMINIO="${IP//./-}.sslip.io"
  EMAIL=""
  while [ -z "$EMAIL" ]; do EMAIL="$(perguntar 'Seu e-mail (será o administrador): ')"; done

  umask 077
  cat > .env <<ENV
APP_NAME=EmitAI
APP_URL=https://$DOMINIO
DOMINIO=$DOMINIO
NODE_ENV=production
POSTGRES_PASSWORD=$(openssl rand -hex 24)
NFSE_MASTER_KEY=$(openssl rand -base64 32)
SUPERADMIN_EMAILS=$EMAIL
SUPPORT_EMAIL=$EMAIL
EMAIL_FROM=nao-responda@$DOMINIO
TRIAL_DAYS=14
TRUST_PROXY=1
ASAAS_AMBIENTE=sandbox
DIAS_TOLERANCIA=5
# Preencha depois e rode: emitai reiniciar
# SMTP_URL=smtps://usuario:senha@smtp.seuprovedor.com:465
# ASAAS_API_KEY=
# ASAAS_WEBHOOK_TOKEN=
ENV
  echo ".env criado em $PASTA/.env"
  echo "IMPORTANTE: faça uma cópia da linha NFSE_MASTER_KEY em local seguro."
  echo "Sem ela, os certificados guardados no sistema não podem ser lidos."
else
  echo ".env já existe, mantido como está."
fi
DOMINIO="$(grep -E '^DOMINIO=' .env | cut -d= -f2-)"

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi

cat > /usr/local/bin/emitai <<CMD
#!/usr/bin/env bash
# Atalhos do EmitAI neste servidor.
cd "$PASTA"
case "\${1:-}" in
  links)     docker compose logs --no-log-prefix app | grep '\[email\]' | tail -n 20 ;;
  logs)      $COMPOSE logs -f --tail 100 ;;
  reiniciar) $COMPOSE up -d ;;
  parar)     $COMPOSE stop ;;
  atualizar) curl -fsSL https://raw.githubusercontent.com/jcrjuliana2111-crypto/controle-fiscal/$BRANCH/nfse/instalar-vps.sh | bash ;;
  backup)    f="/root/emitai-backup-\$(date +%Y%m%d-%H%M).sql.gz"; docker compose exec -T db pg_dump -U nfse nfse | gzip > "\$f"; echo "Backup salvo em \$f" ;;
  *) echo "Uso: emitai links | logs | reiniciar | parar | atualizar | backup" ;;
esac
CMD
chmod +x /usr/local/bin/emitai

passo 5/6 "Subindo o sistema (a primeira vez leva alguns minutos)..."
$COMPOSE up -d --build

passo 6/6 "Esperando o sistema responder..."
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:3333/saude >/dev/null 2>&1; then OK=1; break; fi
  sleep 3
done
if [ -z "${OK:-}" ]; then
  echo "O sistema não respondeu. Veja o erro com: emitai logs"
  exit 1
fi

echo
echo "=============================================="
echo " Pronto! Acesse: https://$DOMINIO"
echo "=============================================="
echo " 1. Crie sua conta com o e-mail de administrador."
echo " 2. Como o envio de e-mail ainda não foi configurado, o link de"
echo "    confirmação aparece aqui no servidor. Para ver, digite: emitai links"
echo
echo " O certificado HTTPS pode levar 1 minuto para ficar pronto."
echo " Comandos úteis: emitai links | logs | reiniciar | atualizar | backup"
