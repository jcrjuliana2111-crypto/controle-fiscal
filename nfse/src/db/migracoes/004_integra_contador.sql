-- Integra Contador (SERPRO): configuração da plataforma, contribuintes,
-- histórico de chamadas (com custo), documentos gerados e DAS do MEI.

CREATE TABLE plataforma_config (
  chave         text PRIMARY KEY,
  valor         jsonb NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

-- Escritório da conta como procurador (quando não é o próprio contratante).
ALTER TABLE contas ADD COLUMN integra jsonb NOT NULL DEFAULT '{}';

CREATE TABLE contribuintes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conta_id      uuid NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  documento     text NOT NULL,
  nome          text NOT NULL,
  regime        text NOT NULL DEFAULT 'MEI' CHECK (regime IN ('MEI', 'SN', 'LP', 'LR', 'PF', 'Outro')),
  email         citext,
  telefone      text,
  das_automatico boolean NOT NULL DEFAULT false,
  observacao    text,
  ativo         boolean NOT NULL DEFAULT true,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX contribuintes_doc ON contribuintes (conta_id, documento) WHERE ativo;

CREATE TABLE integra_chamadas (
  id             bigserial PRIMARY KEY,
  conta_id       uuid NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  usuario_id     uuid,
  chave_api_id   uuid,
  contribuinte   text NOT NULL,
  codigo         text NOT NULL,          -- SISTEMA.SERVICO
  tipo           text NOT NULL,          -- Consultar | Emitir | Declarar | Monitorar | Apoiar
  categoria      text NOT NULL,          -- consulta | emissao | declaracao (para custo)
  ambiente       text NOT NULL,
  sucesso        boolean NOT NULL,
  status_http    int,
  mensagens      jsonb NOT NULL DEFAULT '[]',
  resposta       jsonb,                  -- sem os PDFs
  ms             int,
  origem         text NOT NULL DEFAULT 'manual',  -- manual | api | automatico
  criado_em      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON integra_chamadas (conta_id, criado_em DESC);
CREATE INDEX ON integra_chamadas (criado_em);

CREATE TABLE documentos_fiscais (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conta_id       uuid NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  contribuinte   text NOT NULL,
  chamada_id     bigint REFERENCES integra_chamadas(id) ON DELETE SET NULL,
  codigo         text NOT NULL,
  descricao      text NOT NULL,
  nome_arquivo   text NOT NULL,
  conteudo       bytea NOT NULL,
  criado_em      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON documentos_fiscais (conta_id, criado_em DESC);

CREATE TABLE das_mei (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conta_id        uuid NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  contribuinte_id uuid NOT NULL REFERENCES contribuintes(id) ON DELETE CASCADE,
  competencia     text NOT NULL,         -- AAAAMM
  status          text NOT NULL CHECK (status IN ('gerado', 'enviado', 'pago', 'erro')),
  valor           numeric(12, 2),
  vencimento      date,
  codigo_barras   text,
  documento_id    uuid REFERENCES documentos_fiscais(id) ON DELETE SET NULL,
  erro            text,
  enviado_em      timestamptz,
  lembrete_em     timestamptz,
  pago_em         timestamptz,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  atualizado_em   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contribuinte_id, competencia)
);
CREATE INDEX ON das_mei (conta_id, competencia);
