# Emissor de NFS-e

Sistema de emissão de Nota Fiscal de Serviço Eletrônica que atende:

| Provedor | Quem usa | Transporte | Situação |
|---|---|---|---|
| **Padrão Nacional** (Sefin Nacional / ADN) | Todos os municípios conveniados ao Emissor Nacional — é o **padrão** para qualquer município não cadastrado como "sistema próprio" | REST + mTLS, DPS v1.01 (GZip/Base64), assinatura RSA-SHA256 | Emissão, consulta (por chave e por ID da DPS), cancelamento (evento e101101), DANFSe oficial em PDF, parâmetros municipais |
| **ABRASF 2.x** | Prefeituras com webservice próprio no padrão ABRASF (Betha, ISSNet, WebISS, Fiorilli, e-Governe, SigISS…) | SOAP 1.1/1.2, assinatura RSA-SHA1 | `GerarNfse`, `ConsultarNfsePorRps`, `CancelarNfse` — configurável por município (presets 2.04, 2.02, Betha) |
| **NFS-e Paulistana** | São Paulo/SP (sistema próprio, leiaute v1) | SOAP, assinatura do RPS (string de 86 posições) + XMLDSig | `EnvioRPS`, `ConsultaNFe`, `CancelamentoNFe`; em homologação usa `TesteEnvioLoteRPS` (SP não tem ambiente de testes) |

O provedor é escolhido **automaticamente** pelo código IBGE do município do prestador (pode ser forçado no cadastro do prestador).

## Funcionalidades

- Cadastro de prestadores (regime do Simples Nacional, regime especial, série e numeração de RPS/DPS, ambiente homologação/produção).
- Certificado digital **A1 (.pfx)**: validação de senha/validade, conferência do CNPJ, armazenamento cifrado (AES-256-GCM). Nunca é devolvido pela API.
- Emissão com cálculo de ISS, ISS retido, retenções federais (PIS, COFINS, INSS, IRRF, CSLL) e valor líquido (em centavos, sem erro de arredondamento).
- Tomador PJ, PF, estrangeiro (NIF) ou não identificado; busca de endereço/IBGE pelo CEP.
- **CNPJ alfanumérico** (a partir de jul/2026) aceito e validado.
- Grupo **IBS/CBS** (Reforma Tributária, LC 214/2025) opcional na DPS Nacional.
- Pré-visualização do XML assinado antes de transmitir.
- Numeração serializada por prestador (emissões simultâneas não repetem número); rejeições não consomem número; falha de comunicação deixa a nota em "processando" para consulta posterior (evita duplicidade).
- Lista de notas com consulta de situação, cancelamento, download do XML, DANFSe (Nacional) ou espelho imprimível (prefeituras) e exportação CSV.
- Cadastro de municípios com sistema próprio pela própria tela.

## Como rodar

Requer Node.js 20+.

```bash
cd nfse
npm install
NFSE_SECRET="uma-frase-longa-e-secreta" npm start
# abra http://127.0.0.1:3333
```

Variáveis de ambiente:

| Variável | Padrão | Para quê |
|---|---|---|
| `NFSE_SECRET` | (inseguro) | Chave que cifra certificados e senhas em disco. **Obrigatória em produção** — se mudar, os certificados precisam ser reinstalados. |
| `NFSE_API_TOKEN` | vazio | Se definido, a API exige `Authorization: Bearer <token>` (a tela pede o token no botão 🔑). Use sempre que o servidor não for só local. |
| `PORT` / `HOST` | `3333` / `127.0.0.1` | Endereço do servidor. Para expor na rede use `HOST=0.0.0.0` **com** `NFSE_API_TOKEN` e HTTPS na frente (nginx/Caddy). |
| `NFSE_DATA_DIR` | `nfse/data` | Onde fica o `db.json` (prestadores, notas e XMLs). Faça backup — os XMLs autorizados devem ser guardados por 5 anos. |
| `NFSE_CORS_ORIGIN` | `*` | Origem autorizada a chamar a API pelo navegador. |

Testes: `npm test` (validações, cálculo, certificado, montagem e assinatura dos XMLs dos três provedores e fluxo completo contra servidores simulados).

## Primeiros passos

1. **Prestadores → Novo prestador**: preencha CNPJ, inscrição municipal e o **código IBGE** do município. Deixe em *Homologação*.
2. Instale o certificado A1 (.pfx + senha).
3. **Emitir nota**: confira o provedor mostrado abaixo do prestador, preencha tomador, serviço e valores, clique em **Ver XML** e depois **Emitir**.
4. Validado em homologação, mude o prestador para *Produção*.

### Padrão Nacional

- O prestador precisa estar habilitado no **Cadastro Nacional (CNC)** e o município precisa ter convênio ativo com o Emissor Nacional.
- `cTribNac` = item + subitem + desdobro da LC 116 (6 dígitos, ex.: `010701`). Se ficar vazio, é derivado do item com desdobro `01`.
- Alíquota (`pAliq`): para não optantes o ADN usa a alíquota parametrizada pelo município; ela só é enviada para optante ME/EPP ou quando há ISS retido.
- O endereço/nome do prestador não são enviados (o ADN usa o CNC).

### Prefeituras com sistema próprio (ABRASF)

Em **Municípios → Cadastrar município** informe o código IBGE, o leiaute (preset) e as URLs de homologação e produção **do manual da prefeitura**. Diferenças entre provedores (namespace do serviço, SOAPAction, SOAP 1.2, nome do grupo do tomador, algoritmo de assinatura) podem ser ajustadas em "Opções avançadas", por exemplo:

```json
{ "soapVersion": "1.2", "nsServico": "http://www.exemplo.gov.br/nfse", "soapAction": "{operacao}", "tagTomador": "Tomador", "algoritmo": "sha256" }
```

As URLs não vêm pré-cadastradas de propósito: elas mudam com frequência e cada prefeitura precisa ser homologada com o seu próprio manual.

### São Paulo

Usa o leiaute v1 da NFS-e Paulistana. Informe o **código de serviço de SP** (5 dígitos) e a tributação (T/F/I/J). Como a prefeitura não oferece homologação, no ambiente de homologação a mensagem é enviada ao `TesteEnvioLoteRPS`, que valida tudo sem gerar nota (status "Validada (teste)").

## Pontos de atenção antes de produção

- **Homologue cada cenário** (tomador PF/PJ/exterior, retenções, Simples Nacional) no ambiente de produção restrita do Nacional e no ambiente de testes de cada prefeitura: os leiautes foram implementados conforme as especificações públicas, mas regras de validação mudam por notas técnicas.
- **Reforma Tributária**: o grupo IBS/CBS está implementado no nível mínimo (CST/cClassTrib, finalidade, indicador da operação, destinatário). Acompanhe as notas técnicas do leiaute 1.01+ e o novo leiaute de São Paulo.
- A persistência em arquivo JSON atende um escritório; para múltiplos usuários migre para Postgres/Supabase (a interface `db.get()/db.update()` em `src/store/db.js` isola isso).

## Estrutura

```
nfse/
├── server.js                 # servidor HTTP (API + tela)
├── public/index.html         # interface web
├── data/municipios.json      # municípios com sistema próprio (versionado)
├── src/
│   ├── api/rotas.js          # endpoints REST /api/*
│   ├── core/                 # emissão, cálculo, validação, certificado, assinatura, municípios
│   ├── providers/            # nacional.js, abrasf.js, sao-paulo.js
│   ├── store/db.js           # persistência
│   └── espelho.js            # espelho imprimível da nota
└── test/                     # node --test
```

### API (resumo)

| Método | Rota | Descrição |
|---|---|---|
| GET/POST/PUT/DELETE | `/api/prestadores[/:id]` | Cadastro de prestadores |
| POST | `/api/prestadores/:id/certificado` | `{ pfxBase64, senha }` |
| GET | `/api/prestadores/:id/parametros/:ibge?servico=` | Parâmetros municipais no ADN |
| GET/PUT/DELETE | `/api/municipios[/:ibge]` | Municípios com sistema próprio |
| POST | `/api/calcular` | Cálculo de ISS/retenções/líquido |
| POST | `/api/notas/previsualizar` | XML assinado sem transmitir |
| POST | `/api/notas` | Emitir |
| GET | `/api/notas`, `/api/notas.csv` | Listar / exportar |
| POST | `/api/notas/:id/consultar` | Atualiza situação no fisco |
| POST | `/api/notas/:id/cancelar` | `{ codigo, motivo }` |
| GET | `/api/notas/:id/xml[?tipo=envio]`, `/danfse`, `/espelho` | Documentos |
