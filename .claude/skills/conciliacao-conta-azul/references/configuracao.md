# Configuração inicial e problemas comuns

## Sumário
1. Criar o app no Conta Azul
2. Banco de dados (migrações)
3. Secrets e publicação da função
4. Conectar
5. Problemas comuns

## 1. Criar o app no Conta Azul

1. Acessar o Portal do Desenvolvedor Conta Azul (https://developers.contaazul.com) e criar conta.
2. Criar um aplicativo. **URL de redirecionamento**:
   `https://qftusjwnlyjokilcjuzb.supabase.co/functions/v1/conta-azul`
3. Anotar `client_id` e `client_secret` — guardar fora do código e do chat.

Endereços usados pelo robô (podem ser sobrescritos por secrets):

| Secret opcional | Padrão |
|---|---|
| `CONTA_AZUL_AUTH_URL` | `https://auth.contaazul.com/login` |
| `CONTA_AZUL_TOKEN_URL` | `https://auth.contaazul.com/oauth2/token` |
| `CONTA_AZUL_API_URL` | `https://api-v2.contaazul.com` |

## 2. Banco de dados

No SQL Editor do Supabase (ou `supabase db push`), nesta ordem:

1. `supabase/migrations/20261009000000_conta_azul_conciliacao.sql` — tabelas
   `conta_azul_tokens`, `conta_azul_oauth_state`, `conciliacao_log` (RLS ligado,
   sem políticas: só a função acessa).
2. `supabase/migrations/20261009010000_conciliacao_comprovantes.sql` — colunas
   `comprovante_url`/`anexo` no log e bucket `comprovantes` (público, caminho
   aleatório, até 10 MB).

## 3. Secrets e publicação

```bash
supabase secrets set \
  CONTA_AZUL_CLIENT_ID=... \
  CONTA_AZUL_CLIENT_SECRET=... \
  CONTA_AZUL_REDIRECT_URI=https://qftusjwnlyjokilcjuzb.supabase.co/functions/v1/conta-azul \
  APP_URL=https://ENDERECO-DO-SITE/conciliacao.html \
  ROBO_KEY=uma-senha-forte

supabase functions deploy conta-azul --no-verify-jwt
```

- `ROBO_KEY`: senha que a tela envia no cabeçalho `x-robo-key`. Sem ela ninguém
  dispara baixas, mesmo sabendo a URL da função.
- `--no-verify-jwt`: o app não tem login Supabase; a proteção é a `ROBO_KEY`.
- Opcional: `CONTA_AZUL_ANEXO_PATH` (ex.:
  `/v1/financeiro/eventos-financeiros/parcelas/{parcela_id}/anexos`) e
  `CONTA_AZUL_ANEXO_CAMPO` (padrão `file`) para anexo nativo.

## 4. Conectar

`conciliacao.html` → digitar a chave do robô → **Verificar** → **Conectar Conta
Azul** → login no Conta Azul → autorizar → volta com "conectado". A lista de
contas financeiras passa a aparecer no passo 2 da tela.

## 5. Problemas comuns

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| "Chave do robô inválida" (401) | `ROBO_KEY` digitada diferente do secret, ou secret não cadastrado | Conferir o secret e redigitar na tela |
| "Conta Azul não conectado" | Token nunca obtido ou tabela vazia | Clicar em Conectar Conta Azul |
| "Estado inválido ou expirado" no retorno do login | Demorou mais de 15 min ou clicou duas vezes | Conectar de novo |
| "Token Conta Azul 400/401" | `client_secret` ou redirect diferente do cadastrado no app; refresh token revogado | Conferir secrets e o redirect no app; reconectar |
| "Conta Azul 400 em …/baixa" | Campo recusado (forma de pagamento, conta financeira, versão da parcela) | Ler a mensagem na coluna Resultado; testar outra forma de pagamento; conferir a conta financeira |
| "Conta Azul 429" | Muitas chamadas seguidas | Esperar um pouco e repetir só as linhas com erro |
| Nenhuma conta financeira na lista | Sem conexão ou contas inativas | Verificar conexão; ativar a conta no Conta Azul |
| Comprovante não ligado | Valor/data não encontrados ou ambiguidade | Rodar `scripts/verificar_comprovantes.js`; padronizar o nome; anexar à mão |
| Movimento "já conciliado" ignorado | Mesmo OFX enviado de novo (proteção contra baixa dupla) | Nada — é o esperado |
| "Sem permissão para ler a pasta" | Chrome/Edge perdeu a permissão | Rodar de novo e aceitar o pedido, ou escolher a pasta outra vez |
