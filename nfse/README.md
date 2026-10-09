# EmitAI — emissão de NFS-e (SaaS)

Plataforma multiempresa para emissão de Nota Fiscal de Serviço Eletrônica, vendida por assinatura para escritórios contábeis e empresas de serviço.

| Padrão | Quem usa | Situação |
|---|---|---|
| **Portal Nacional** (Sefin Nacional / ADN, DPS 1.01) | Todos os municípios conveniados ao Emissor Nacional. É o padrão para qualquer município não cadastrado como "sistema próprio" | Emissão, consulta, cancelamento, DANFSe em PDF, parâmetros municipais |
| **ABRASF 2.x** | Prefeituras com webservice próprio (Betha, ISSNet, WebISS e outros) | Emissão, consulta e cancelamento, configuráveis por município |
| **NFS-e Paulistana** | São Paulo capital | Emissão, consulta e cancelamento (em homologação usa o teste de validação da prefeitura) |

## O que o produto tem

**Para o cliente**
- Cadastro com teste grátis (14 dias), login, recuperação de senha e confirmação de e-mail.
- Várias empresas emitentes por conta, cada uma com seu certificado A1, numeração e ambiente (homologação ou produção).
- Equipe com perfis: dono, administrador, emissor e somente leitura; convites por e-mail.
- Emissão com cálculo de ISS, retenções e valor líquido; conferência do XML antes de enviar.
- Lista de notas com busca e filtros, detalhe com histórico, DANFSe ou impressão, XML, cancelamento e exportação para planilha.
- Painel com faturamento, ISS do mês, uso do plano e certificados vencendo.
- Integração: API REST com chaves de acesso e webhooks assinados (HMAC-SHA256) com reenvio automático. Documentação pública em `/docs.html`.
- Histórico de atividades (quem fez o quê, quando e de qual IP).

**Certificados digitais (controle e venda)**
- Carteira de certificados com prazo de vencimento: os das empresas emitentes entram sozinhos; os dos clientes podem ser cadastrados à mão ou lidos do .pfx (o arquivo não é guardado).
- Avisos automáticos por e-mail 30, 15, 7 e 1 dia antes e no dia do vencimento, para dono e administradores, e opcionalmente para o cliente, com link de renovação.
- Link público de venda por conta (`/certificado.html?c=SEU-LINK`): o cliente escolhe o tipo, preenche os dados e o pedido chega no sistema e por e-mail. Depois do pedido, o cliente pode seguir para o link de compra da certificadora e para o seu WhatsApp.
- Acompanhamento dos pedidos por situação e botão para copiar os dados formatados para o sistema da certificadora (GestãoFácil/Digibras), até existir integração por API.
- Eventos `certificado.vencendo` e `pedido_certificado.criado` nos webhooks.

**Fiscal: Integra Contador (SERPRO)**
- Catálogo com 93 serviços da Receita em 7 grupos: MEI (DAS em PDF ou código de barras, CCMEI, DASN-SIMEI, dívida ativa), Simples Nacional (PGDAS-D, DAS, extratos, regime de apuração, DEFIS), parcelamentos (PARCSN, PERT, RELP, PARCMEI e especiais), situação fiscal (relatório em PDF, Caixa Postal do e-CAC, DTE, procurações), DCTFWeb e MIT, DARF/SICALC e pagamentos, monitoramento de eventos.
- Carteira de clientes (com importação colando de planilha) e histórico de cada consulta, com os PDFs guardados.
- DAS do MEI automático: todo mês, a partir do dia configurado, gera o DAS da competência anterior e envia por e-mail com o PDF; lembrete antes do vencimento; controle de pago.
- Cota mensal de requisições por plano e custo estimado no SERPRO por conta.
- Multiescritório: a plataforma é o CONTRATANTE do SERPRO. Contas marcadas como "próprias" pelo administrador usam as procurações do contratante; os demais escritórios instalam o próprio e-CNPJ e o sistema assina o termo de autorização (AUTENTICAPROCURADOR) automaticamente, então nenhum cliente acessa procurações de outro.
- Ambiente de testes (trial) do SERPRO por padrão; produção é ativada na Administração.

**Cobrança (Asaas)**
- O dono da conta escolhe o plano e é levado à fatura do Asaas (Pix, boleto ou cartão). O plano é liberado quando o pagamento é confirmado.
- Troca de plano a qualquer momento (o novo valor vale para a fatura em aberto e as próximas); a redução é bloqueada se a conta usa mais do que o plano menor permite.
- Pagamento atrasado: aviso no sistema e, após `DIAS_TOLERANCIA` dias, suspensão automática da emissão, com e-mail ao dono. Pagou, liberou na hora.
- Cancelamento: o plano continua até o fim do período pago; depois a emissão em produção é bloqueada (dados e notas continuam guardados).
- Lista de faturas com link para pagar ou ver o recibo.

**Para você (dono da plataforma)**
- Página de vendas (`/`) com a tabela de planos lida do sistema.
- Área de administração: contas, plano, situação (ativa/suspensa/cancelada) e prorrogação de teste.
- Planos com limites aplicados pelo servidor (notas por mês em produção, empresas, usuários, acesso à API). Edite preços e limites em `src/saas/planos.js`.

**Segurança**
- Dados de cada cliente isolados por conta em todas as consultas (há testes que tentam acessar dados de outra conta).
- Certificados cifrados com criptografia em envelope: chave por certificado, protegida pela `NFSE_MASTER_KEY`.
- Senhas com scrypt; sessões em cookie `HttpOnly`/`Secure`/`SameSite`; proteção CSRF; limite de tentativas de login.
- Cabeçalhos de segurança (CSP sem scripts inline, HSTS, anti-clickjacking).
- Bloqueio de SSRF: webhooks e URLs de prefeitura não podem apontar para a rede interna.
- Superadmin só para e-mails da lista **já confirmados**.
- Idempotência na emissão (`Idempotency-Key`) e numeração atômica: emissões simultâneas não repetem número de RPS/DPS.

## Rodar no seu computador

Requer Node.js 20+ e PostgreSQL 14+ (ou Docker).

**Com Docker (mais simples):**
```bash
cd nfse
cp .env.example .env        # edite: POSTGRES_PASSWORD, NFSE_MASTER_KEY, SUPERADMIN_EMAILS
docker compose up -d --build
# abra http://127.0.0.1:3333
```

**Sem Docker:**
```bash
cd nfse
npm install
createdb nfse                                   # PostgreSQL local
export DATABASE_URL=postgres://usuario:senha@127.0.0.1:5432/nfse
export SUPERADMIN_EMAILS=voce@seudominio.com.br
npm start                                       # cria as tabelas sozinho
```

Sem SMTP configurado, os e-mails (confirmação, convite, senha) aparecem no terminal com o link. Para virar administrador da plataforma: cadastre-se com o e-mail de `SUPERADMIN_EMAILS`, abra o link de confirmação que aparece no terminal e entre de novo.

**Testes:** `npm test` (precisa de um banco de teste; padrão `postgres://nfse:nfse@127.0.0.1:5432/nfse_test`, ou defina `DATABASE_URL`). **O banco de teste é apagado a cada execução.**

## Colocar no ar (produção)

1. Um servidor (VPS) com Docker, ou qualquer hospedagem Node.js + PostgreSQL gerenciado.
2. Domínio com HTTPS. Exemplo com Caddy na frente da aplicação:
   ```
   app.seudominio.com.br {
     reverse_proxy 127.0.0.1:3333
   }
   ```
3. `.env` de produção (veja `.env.example`): `NODE_ENV=production`, `APP_URL=https://…`, `NFSE_MASTER_KEY` (gere com `openssl rand -base64 32`), `SMTP_URL`, `SUPPORT_EMAIL`, `SUPERADMIN_EMAILS`.
4. **Guarde a `NFSE_MASTER_KEY` fora do servidor** (gerenciador de senhas). Sem ela, os certificados dos clientes não podem ser lidos; se vazar, troque-a e peça aos clientes que reinstalem os certificados.
5. **Backup diário do PostgreSQL** (os XMLs autorizados devem ser guardados por 5 anos). Ex.: `pg_dump` agendado enviado a um armazenamento externo, ou backup automático do banco gerenciado.
6. Monitore `GET /saude` (retorna 200 com o banco no ar). Os logs de requisição saem em JSON no stdout.

O servidor aplica as migrações do banco ao iniciar (com trava, seguro para várias instâncias). Para mais de uma instância, troque o limitador de tentativas em memória (`src/saas/limitador.js`) por Redis.

## Configurar a cobrança (Asaas)

1. No Asaas **sandbox** (conta de testes, gratuita): *Integrações → Chave de API* e copie a chave para `ASAAS_API_KEY`, com `ASAAS_AMBIENTE=sandbox`.
2. *Integrações → Webhooks*: crie um webhook com a URL `https://SEU-DOMINIO/api/v1/cobranca/asaas`, defina um **token de autenticação** (o mesmo valor em `ASAAS_WEBHOOK_TOKEN`) e marque os eventos de **cobranças** e de **assinaturas**.
3. Reinicie o sistema, entre como dono de uma conta, preencha o CNPJ/CPF em *Plano e conta* e clique em **Assinar**. No sandbox, simule o pagamento da fatura pelo painel do Asaas e veja o plano ser liberado.
4. Funcionando, troque para a chave de **produção** e `ASAAS_AMBIENTE=producao`, e cadastre o webhook também na conta de produção.

Você continua podendo mudar plano e situação manualmente na Administração (por exemplo, para um cliente que paga por fora). Suspensões manuais não são desfeitas por pagamentos automáticos.

## Configurar o Integra Contador

1. Na Área do Cliente do SERPRO, copie a **Consumer Key** e o **Consumer Secret**.
2. No EmitAI, entre como administrador da plataforma, abra **Administração → Integra Contador** e informe: CNPJ e razão social do contratante, as duas chaves e o e-CNPJ (.pfx) do contratante com a senha. Mantenha em **Testes (trial)** até conferir.
3. Marque como **"própria"** a conta do seu escritório (ela usará as procurações dadas ao CNPJ contratante).
4. Faça uma consulta simples em **Fiscal → Serviços** (ex.: "Situação cadastral do MEI" de um cliente com procuração) e, funcionando, mude o ambiente para **Produção**.
5. Cada cliente precisa ter dado **procuração eletrônica no e-CAC** ao CNPJ do escritório, com os serviços desejados.

## Antes de vender: o que ainda depende de você

- **Ativar o Asaas** (veja "Configurar a cobrança" abaixo) e fazer um pagamento de teste no sandbox antes de usar a chave de produção.
- **Homologação real.** Os leiautes foram implementados pelas especificações públicas e testados contra simuladores, mas este ambiente de desenvolvimento não acessa o gov.br. Emita em homologação com um certificado real no Portal Nacional, em São Paulo e em cada prefeitura ABRASF que for atender, cenário por cenário (PF, PJ, exterior, retenções, Simples Nacional).
- **Documentos legais e LGPD.** Termos de uso, política de privacidade e contrato de tratamento de dados (você será operador de dados dos clientes e guardará certificados digitais). Revise com um advogado.
- **Marca.** O nome vem de `APP_NAME` (padrão: EmitAI); troque também `public/assets/marca.svg` se tiver um logotipo.
- **Prefeituras ABRASF.** Cadastre na Administração (configuração global) as prefeituras que seus clientes usam, para que eles não precisem configurar nada.
- **Reforma tributária.** O grupo IBS/CBS está no nível mínimo; acompanhe as notas técnicas do Portal Nacional e o novo leiaute de São Paulo.

## Estrutura

```
nfse/
├── server.js                    # servidor HTTP (API /api/v1 + páginas)
├── Dockerfile, docker-compose.yml, .env.example
├── public/                      # site, login, aplicativo e documentação da API
│   ├── index.html  entrar.html  app.html  docs.html
│   └── assets/                  # CSS e JS (sem scripts inline)
├── data/municipios.json         # integrações nativas (São Paulo)
├── src/
│   ├── db/                      # conexão e migrações SQL
│   ├── saas/                    # contas, sessões, planos, cobrança (Asaas), equipe, webhooks, auditoria, e-mail
│   ├── api/                     # rotas e middleware (auth, CSRF, permissões)
│   ├── core/                    # notas, empresas, municípios, cálculo, validação, certificado, assinatura
│   ├── providers/               # nacional.js, abrasf.js, sao-paulo.js
│   └── util/                    # XML, HTTP/SOAP, criptografia, proteção de rede
└── test/                        # node --test (unidade + integração com PostgreSQL)
```
