# Robô de conciliação · Conta Azul

Lê o extrato do banco (OFX ou CSV), encontra a conta a receber/pagar em aberto
no Conta Azul que corresponde a cada movimento e dá baixa nela pela API.

```
conciliacao.html ──► Edge Function "conta-azul" (Supabase) ──► API v2 Conta Azul
   (lê extrato,          (guarda o token OAuth,                (contas a receber/pagar,
    sugere pares)         busca parcelas, dá baixa)              baixa de parcela)
```

## Como o robô decide

Um movimento do extrato casa com uma parcela quando:

1. **Tipo** – entrada no banco ↔ conta a receber; saída ↔ conta a pagar.
2. **Valor** – idêntico, ao centavo, ao valor em aberto da parcela.
3. **Data** – vencimento até *N* dias do lançamento no banco (padrão 5).

Entre vários candidatos, ganha o de data mais próxima e cujo nome do
cliente/fornecedor aparece no histórico do extrato. Cada parcela é usada uma
única vez.

- **Alta**: nome bate (ou é o único candidato possível) e diferença ≤ 3 dias. Já vem marcada.
- **Média / baixa**: aparece desmarcada para você revisar.

Nada é baixado sem você clicar em **Dar baixa nos selecionados** e confirmar.
Cada movimento baixado fica registrado em `conciliacao_log`; se você subir o
mesmo extrato de novo, ele é ignorado (não há baixa dupla).

## Configuração (uma vez)

### 1. Criar o app no Conta Azul

1. Acesse o [Portal do Desenvolvedor Conta Azul](https://developers.contaazul.com) e crie uma conta.
2. Crie um aplicativo. Em **URL de redirecionamento** coloque:
   `https://qftusjwnlyjokilcjuzb.supabase.co/functions/v1/conta-azul`
3. Anote o `client_id` e o `client_secret`. **Não** coloque esses valores no código nem no GitHub.

### 2. Banco de dados

Rode a migração (SQL Editor do Supabase ou `supabase db push`):
`supabase/migrations/20261009000000_conta_azul_conciliacao.sql`

### 3. Segredos e deploy da função

```bash
supabase secrets set \
  CONTA_AZUL_CLIENT_ID=... \
  CONTA_AZUL_CLIENT_SECRET=... \
  CONTA_AZUL_REDIRECT_URI=https://qftusjwnlyjokilcjuzb.supabase.co/functions/v1/conta-azul \
  APP_URL=https://SEU-SITE/conciliacao.html \
  ROBO_KEY=uma-senha-forte-so-sua

supabase functions deploy conta-azul --no-verify-jwt
```

`ROBO_KEY` protege a função: sem ela ninguém consegue disparar baixas, mesmo
sabendo a URL. Você digita essa senha uma vez na tela do robô (fica salva só
no seu navegador).

### 4. Conectar

Abra `conciliacao.html` → informe a chave do robô → **Conectar Conta Azul** →
faça login no Conta Azul e autorize. O token é renovado automaticamente.

## Uso no dia a dia

1. Exporte o extrato do banco em **OFX** (recomendado) ou CSV.
2. Escolha a conta financeira correspondente no Conta Azul.
3. **Rodar conciliação** → revise as sugestões → **Dar baixa nos selecionados**.
4. Veja as abas *Extrato sem lançamento* (tarifas, entradas sem cadastro) e
   *Lançamentos sem extrato* (o que ainda não caiu no banco). Exporte em CSV se precisar.

## Limitações conhecidas

- Pagamentos com juros/desconto (valor diferente da parcela) e um depósito que
  quita várias parcelas de uma vez não são casados automaticamente — aparecem
  em *Extrato sem lançamento* para tratar à mão.
- Os caminhos da API usados estão em `supabase/functions/conta-azul/index.ts`.
  Se o Conta Azul mudar a API, ajuste lá; o erro retornado pela API aparece na
  coluna *Resultado* da tela.

## Testes

```bash
node --test tests/*.test.js
```
