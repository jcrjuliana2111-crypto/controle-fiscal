---
name: conciliacao-conta-azul
description: Fluxo completo da conciliação bancária do escritório no Conta Azul usando o robô do repositório controle-fiscal (conciliacao.html + Edge Function conta-azul no Supabase) — da configuração inicial (app no Portal do Desenvolvedor, migrações, secrets, OAuth) à rotina diária (extrato OFX/CSV, pasta de comprovantes, revisão das sugestões, baixa e anexo do comprovante) e às pendências. Use sempre que o assunto for conciliar extrato com contas a pagar/receber do Conta Azul, dar baixa em lote, anexar comprovante de PIX ou de fornecedor, padrão de nome dos comprovantes ("FAVORECIDO ... R$ 490,00 PIX ENVIADO - FOLHA ...", "FORNECEDOR ... V 051026"), erros do robô de conciliação, ou ajustar as regras de casamento — mesmo que a pessoa não diga "skill" nem "robô".
---

# Conciliação bancária no Conta Azul (robô do escritório)

O escritório concilia o extrato do banco com as contas a pagar/receber do
Conta Azul usando um robô próprio, no repositório `controle-fiscal`:

```
Extrato (OFX/CSV) ─┐
                   ├─► conciliacao.html (navegador) ──► Edge Function "conta-azul" ──► API v2 Conta Azul
Pasta de           │     lê extrato e comprovantes,       guarda o token OAuth,          busca parcelas,
comprovantes ──────┘     sugere pares, você revisa        registra baixa e anexo         registra baixa
```

Arquivos do robô (para consultar ou ajustar):

| Arquivo | O que faz |
|---|---|
| `conciliacao.html` | Tela do robô (botão "🤖 Conciliação Conta Azul" no `index.html`) |
| `conciliacao-core.js` | Regras: leitura de OFX/CSV, casamento extrato ↔ parcela, leitura e casamento de comprovantes |
| `supabase/functions/conta-azul/index.ts` | OAuth, busca de parcelas, baixa, upload/anexo de comprovante |
| `supabase/migrations/2026100900*.sql` | Tabelas de token, log de baixas e bucket `comprovantes` |
| `tests/conciliacao.test.js` | Testes (`node --test tests/*.test.js`) |
| `docs/conciliacao-conta-azul.md` | Documentação para o usuário |

## Princípios (o porquê importa)

- **Nada é baixado sem confirmação humana.** Baixa altera o financeiro real do
  cliente; o robô só sugere, a pessoa marca e confirma. Não proponha automatizar
  a baixa sem revisão.
- **Sem IA para ler comprovantes.** A usuária pediu explicitamente para não
  gastar tokens: a leitura é local (texto do PDF via PDF.js + nome do arquivo).
  Não reintroduza chamadas a modelos no robô; se uma imagem não for reconhecida,
  a saída é padronizar o nome do arquivo.
- **Credenciais nunca no chat nem no código.** `client_id`, `client_secret` e
  `ROBO_KEY` vão só em `supabase secrets set`. Se a pessoa colar um segredo na
  conversa, avise para trocá-lo.
- **Linguagem simples.** Quem usa é da área contábil/financeira, não de TI.
  Explique termos técnicos em uma frase quando aparecerem.

## Etapa 0 — Configuração inicial (uma vez)

Resumo; o passo a passo detalhado, com comandos, está em
`references/configuracao.md` — leia quando a pessoa estiver configurando ou
quando algo de conexão/token falhar.

1. Criar app no Portal do Desenvolvedor Conta Azul com redirect
   `https://qftusjwnlyjokilcjuzb.supabase.co/functions/v1/conta-azul`.
2. Rodar as duas migrações no Supabase (tabelas + bucket `comprovantes`).
3. Cadastrar os secrets e publicar a função `conta-azul` com `--no-verify-jwt`.
4. Abrir `conciliacao.html`, informar a chave do robô (`ROBO_KEY`) e clicar em
   **Conectar Conta Azul** → login → autorizar. O token renova sozinho.

## Etapa 1 — Preparar os arquivos

**Extrato:** exportar do banco em **OFX** (preferido — traz um id único por
movimento, que impede baixa dupla) ou CSV com colunas *Data* e *Valor* (ou
*Crédito*/*Débito*) e, de preferência, *Histórico*.

**Comprovantes:** todos numa pasta (subpastas valem). O robô lê o **nome do
arquivo e o texto do PDF juntos**. Padrões do escritório:

| Tipo | Nome do arquivo (e/ou texto do PDF) | O que o robô usa |
|---|---|---|
| PIX | `FAVORECIDO ALANA GONCALVES RODRIGUES R$ 490,00 PIX ENVIADO - FOLHA MULTI AGO 26.pdf` | valor + nome do favorecido + descrição **igual à do Conta Azul** |
| Fornecedor | `FORNECEDOR F F DISTRIBUIDORA DE PRODUTOS R$ 964,62 V 051026.pdf` | valor + nome + vencimento `V ddmmaa` (05/10/2026) comparado com o vencimento da parcela |

Pontos que costumam dar errado:
- Imagem (JPG/PNG) e PDF escaneado não têm texto legível sem OCR → **o nome do
  arquivo precisa ter o valor** (e o `V ddmmaa` ou o nome).
- Windows não aceita `:` nem `/` em nome de arquivo — use espaços, como nos exemplos.
- Valor sempre com vírgula e centavos: `490,00`, `1.500,00`.

Para conferir uma pasta antes de rodar, use o script
`scripts/verificar_comprovantes.js` (ver "Tarefas comuns").

## Etapa 2 — Rodar a conciliação

Na tela: escolher a **conta financeira** do Conta Azul correspondente ao banco,
a **forma de pagamento** da baixa, a **tolerância de dias** (padrão 5), o
arquivo do extrato e a **pasta de comprovantes** → **▶ Rodar conciliação**.

O robô busca no Conta Azul as parcelas em aberto (EM_ABERTO, ATRASADO,
RECEBIDO_PARCIAL) no período do extrato ± tolerância e ignora movimentos que já
foram baixados antes (tabela `conciliacao_log`). No Chrome/Edge a pasta fica
lembrada; no Firefox/Safari é preciso escolhê-la a cada vez.

## Etapa 3 — Revisar as sugestões

Regras de casamento extrato ↔ lançamento (detalhes e exemplos em
`references/regras.md`):

- entrada no banco ↔ conta a **receber**; saída ↔ conta a **pagar**;
- **valor idêntico ao centavo**;
- vencimento até N dias da data do banco;
- desempate por data mais próxima e nome do contato/descrição no histórico.

Confiança: **alta** (nome bate, ou é o único candidato, e ≤ 3 dias) já vem
marcada; **média/baixa** vem desmarcada para revisar. Ex.: boleto pago com 4
dias de atraso cujo histórico é só "PAGTO BOLETO" fica como média.

Coluna **Comprovante**: mostra o arquivo ligado; dá para remover (✕) ou anexar
à mão (＋ anexar).

## Etapa 4 — Dar baixa e anexar comprovante

**✓ Dar baixa nos selecionados** → confirmar. Para cada linha, a função:

1. consulta a parcela no Conta Azul;
2. registra a baixa (data do banco, valor, conta financeira, forma de pagamento);
3. observação: "Baixa automática (conciliação bancária): <histórico>", **mantendo a observação que o lançamento já tinha** (campo `nota` da parcela);
4. comprovante: **sem link e sem envio de arquivo** (pedido da usuária) — o robô só identifica qual comprovante é de cada lançamento, para anexar à mão.

A coluna *Resultado* mostra `ok`/`erro` e a situação do comprovante:

| Texto | Significado |
|---|---|
| já tinha anexo | nenhum comprovante ligado na linha, mas a parcela já tinha anexo |
| comprovante identificado — anexar à mão | padrão hoje: o arquivo certo foi encontrado; anexar no Conta Azul |
| comprovante anexado | enviado direto ao Conta Azul (só se `CONTA_AZUL_ANEXO_PATH` estiver configurado) |
| sem comprovante | nenhum comprovante ligado e a parcela não tem anexo |

Por que não há anexo automático: a API v2 mostra anexos, mas não há rota
pública documentada para enviá-los (conferido em out/2026; a "captura de
documentos" cria lançamento novo, não serve). A usuária não quer link na
observação. Se o Conta Azul confirmar a rota: voltar o `comprovante-upload` na
tela e configurar `CONTA_AZUL_ANEXO_PATH` (e `CONTA_AZUL_ANEXO_CAMPO`).

## Etapa 5 — Pendências

- **Extrato sem lançamento**: tarifas, juros/descontos (valor diferente da
  parcela), um depósito que paga várias parcelas, lançamentos não cadastrados →
  tratar à mão no Conta Azul.
- **Lançamentos sem extrato**: o que ainda não caiu no banco no período.
- **Sem comprovante**: localizar o arquivo, salvar no padrão e anexar à mão.
- **Exportar CSV** gera o relatório de tudo (sugestões, pendências, comprovantes).

## Tarefas comuns e como ajudar

**"Esse comprovante não foi reconhecido"** → rode o verificador na pasta e
proponha o nome no padrão:

```bash
node .claude/skills/conciliacao-conta-azul/scripts/verificar_comprovantes.js "/caminho/da/pasta"
```

Ele lista, por arquivo, valores, vencimentos e datas que o robô vai enxergar
(lê o nome do arquivo e, se `pdftotext` estiver instalado, o texto do PDF) e
avisa quais ficarão sem valor reconhecível.

**Erro na baixa / conexão** → consulte a tabela de problemas em
`references/configuracao.md` (seção "Problemas comuns").

**Mudar uma regra** (tolerância, novo formato de comprovante, critério de
confiança) → altere `conciliacao-core.js`, acrescente um caso em
`tests/conciliacao.test.js` com o exemplo real (sem dados sensíveis além do
necessário) e rode `node --test tests/*.test.js`. Mantenha o espelho em
`scripts/conciliacao-core.js` desta skill atualizado.

**Explicar o fluxo do zero** → siga as Etapas 0 a 5 nesta ordem, uma de cada
vez, perguntando se a pessoa concluiu antes de passar para a próxima.
