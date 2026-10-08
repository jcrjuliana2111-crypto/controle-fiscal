-- Esquema multiempresa (multi-tenant). Toda tabela de negócio tem conta_id
-- e todas as consultas da aplicação filtram por ele.

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE contas (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome          text NOT NULL,
  documento     text,
  plano         text NOT NULL DEFAULT 'teste',
  status        text NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa', 'suspensa', 'cancelada')),
  teste_ate     timestamptz,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usuarios (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               citext NOT NULL UNIQUE,
  nome                text NOT NULL,
  senha_hash          text NOT NULL,
  superadmin          boolean NOT NULL DEFAULT false,
  email_verificado_em timestamptz,
  ultimo_login_em     timestamptz,
  criado_em           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE membros (
  conta_id   uuid NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  papel      text NOT NULL CHECK (papel IN ('dono', 'admin', 'emissor', 'leitura')),
  criado_em  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conta_id, usuario_id)
);

CREATE TABLE convites (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conta_id   uuid NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  email      citext NOT NULL,
  papel      text NOT NULL CHECK (papel IN ('admin', 'emissor', 'leitura')),
  token_hash text NOT NULL UNIQUE,
  convidado_por uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  expira_em  timestamptz NOT NULL,
  aceito_em  timestamptz,
  criado_em  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessoes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  conta_id   uuid REFERENCES contas(id) ON DELETE SET NULL,
  token_hash text NOT NULL UNIQUE,
  expira_em  timestamptz NOT NULL,
  ip         text,
  user_agent text,
  criado_em  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON sessoes (usuario_id);

CREATE TABLE tokens_usuario (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  tipo       text NOT NULL CHECK (tipo IN ('redefinir_senha', 'verificar_email')),
  token_hash text NOT NULL UNIQUE,
  expira_em  timestamptz NOT NULL,
  usado_em   timestamptz,
  criado_em  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chaves_api (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conta_id    uuid NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  nome        text NOT NULL,
  prefixo     text NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  papel       text NOT NULL DEFAULT 'emissor' CHECK (papel IN ('admin', 'emissor', 'leitura')),
  criado_por  uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  ultimo_uso_em timestamptz,
  revogada_em timestamptz,
  criado_em   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON chaves_api (conta_id);

CREATE TABLE prestadores (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conta_id            uuid NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  razao_social        text NOT NULL,
  documento           text NOT NULL,
  inscricao_municipal text,
  codigo_municipio    text NOT NULL,
  municipio           text,
  uf                  text,
  ambiente            text NOT NULL DEFAULT 'homologacao' CHECK (ambiente IN ('homologacao', 'producao')),
  provedor            text NOT NULL DEFAULT 'auto',
  serie               text NOT NULL DEFAULT '1',
  proximo_numero      bigint NOT NULL DEFAULT 1 CHECK (proximo_numero > 0),
  dados               jsonb NOT NULL DEFAULT '{}',   -- regime tributário, contato, padrões
  certificado         jsonb,                          -- metadados públicos do A1
  cert_pfx            text,                           -- PFX cifrado (envelope)
  cert_senha          text,
  cert_chave          text,                           -- chave de dados cifrada pela chave mestra
  ativo               boolean NOT NULL DEFAULT true,
  criado_em           timestamptz NOT NULL DEFAULT now(),
  atualizado_em       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON prestadores (conta_id);
CREATE UNIQUE INDEX prestadores_doc_unico ON prestadores (conta_id, documento, codigo_municipio) WHERE ativo;

CREATE TABLE municipios (
  codigo     text NOT NULL,
  conta_id   uuid REFERENCES contas(id) ON DELETE CASCADE,  -- NULL = configuração global da plataforma
  nome       text NOT NULL,
  uf         text,
  provedor   text NOT NULL,
  preset     text,
  urls       jsonb NOT NULL DEFAULT '{}',
  opcoes     jsonb,
  observacao text,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX municipios_global ON municipios (codigo) WHERE conta_id IS NULL;
CREATE UNIQUE INDEX municipios_conta ON municipios (conta_id, codigo) WHERE conta_id IS NOT NULL;

CREATE TABLE notas (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conta_id           uuid NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  prestador_id       uuid NOT NULL REFERENCES prestadores(id),
  provedor           text NOT NULL,
  ambiente           text NOT NULL,
  municipio          text,
  serie              text NOT NULL,
  numero_rps         bigint NOT NULL,
  status             text NOT NULL,
  numero             text,
  chave_acesso       text,
  id_dps             text,
  codigo_verificacao text,
  link_consulta      text,
  competencia        date,
  tomador            jsonb NOT NULL DEFAULT '{}',
  servico            jsonb NOT NULL DEFAULT '{}',
  valores            jsonb NOT NULL DEFAULT '{}',
  ibs_cbs            jsonb,
  calculo            jsonb NOT NULL DEFAULT '{}',
  mensagens          jsonb NOT NULL DEFAULT '[]',
  xml_envio          text,
  xml_retorno        text,
  cancelamento       jsonb,
  referencia_externa text,          -- id do pedido/fatura no sistema do cliente
  chave_idempotencia text,
  data_autorizacao   timestamptz,
  criado_por         uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em          timestamptz NOT NULL DEFAULT now(),
  atualizado_em      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON notas (conta_id, criado_em DESC);
CREATE INDEX ON notas (conta_id, status);
CREATE INDEX ON notas (prestador_id);
CREATE UNIQUE INDEX notas_idempotencia ON notas (conta_id, chave_idempotencia) WHERE chave_idempotencia IS NOT NULL;
-- Um número de RPS/DPS só pode ter uma nota "viva" por prestador e série.
CREATE UNIQUE INDEX notas_numero_unico ON notas (prestador_id, ambiente, serie, numero_rps)
  WHERE status IN ('enviando', 'autorizada', 'processando', 'cancelada');

CREATE TABLE eventos_nota (
  id         bigserial PRIMARY KEY,
  nota_id    uuid NOT NULL REFERENCES notas(id) ON DELETE CASCADE,
  conta_id   uuid NOT NULL,
  tipo       text NOT NULL,
  status     text,
  detalhes   jsonb,
  usuario_id uuid,
  criado_em  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON eventos_nota (nota_id);

CREATE TABLE webhooks (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conta_id  uuid NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  url       text NOT NULL,
  segredo   text NOT NULL,
  eventos   text[] NOT NULL DEFAULT ARRAY['nota.autorizada', 'nota.rejeitada', 'nota.cancelada'],
  ativo     boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_entregas (
  id          bigserial PRIMARY KEY,
  webhook_id  uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  conta_id    uuid NOT NULL,
  evento      text NOT NULL,
  payload     jsonb NOT NULL,
  tentativas  int NOT NULL DEFAULT 0,
  status_http int,
  erro        text,
  entregue_em timestamptz,
  proxima_em  timestamptz NOT NULL DEFAULT now(),
  criado_em   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON webhook_entregas (proxima_em) WHERE entregue_em IS NULL;

CREATE TABLE auditoria (
  id         bigserial PRIMARY KEY,
  conta_id   uuid,
  usuario_id uuid,
  chave_api_id uuid,
  acao       text NOT NULL,
  alvo       text,
  detalhes   jsonb,
  ip         text,
  criado_em  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON auditoria (conta_id, criado_em DESC);
