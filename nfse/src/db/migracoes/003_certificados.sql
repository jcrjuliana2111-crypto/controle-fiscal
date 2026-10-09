-- Carteira de certificados (vencimentos e avisos) e pedidos de compra/renovação.
CREATE TABLE certificados (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conta_id          uuid NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  prestador_id      uuid REFERENCES prestadores(id) ON DELETE CASCADE,  -- preenchido quando é o A1 de uma empresa emitente
  titular           text NOT NULL,
  documento         text,
  tipo              text NOT NULL DEFAULT 'e-CNPJ A1',
  emissor           text,
  vencimento        date NOT NULL,
  cliente_nome      text,
  cliente_email     citext,
  cliente_telefone  text,
  avisar_cliente    boolean NOT NULL DEFAULT false,
  observacao        text,
  avisos_enviados   int[] NOT NULL DEFAULT '{}',   -- marcos (dias antes) já avisados para este vencimento
  criado_em         timestamptz NOT NULL DEFAULT now(),
  atualizado_em     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON certificados (conta_id, vencimento);
CREATE UNIQUE INDEX certificados_prestador ON certificados (prestador_id) WHERE prestador_id IS NOT NULL;

-- Certificados já instalados nas empresas emitentes entram na carteira.
INSERT INTO certificados (conta_id, prestador_id, titular, documento, emissor, vencimento)
SELECT conta_id, id, coalesce(certificado->>'titular', razao_social), certificado->>'documento', certificado->>'emissor',
       ((certificado->>'validoAte')::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date
FROM prestadores WHERE ativo AND certificado IS NOT NULL;

-- Venda de certificados: link público da conta.
ALTER TABLE contas
  ADD COLUMN slug                    text UNIQUE,
  ADD COLUMN venda_certificados      jsonb NOT NULL DEFAULT '{}';  -- { ativo, linkCompra, whatsapp, emailAvisos, mensagem }

CREATE TABLE pedidos_certificado (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conta_id      uuid NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  numero        bigint GENERATED ALWAYS AS IDENTITY,
  status        text NOT NULL DEFAULT 'novo'
    CHECK (status IN ('novo', 'em_atendimento', 'aguardando_pagamento', 'aguardando_validacao', 'emitido', 'cancelado')),
  tipo          text NOT NULL,
  dados         jsonb NOT NULL,
  renovacao     boolean NOT NULL DEFAULT false,
  certificado_id uuid REFERENCES certificados(id) ON DELETE SET NULL,
  ip            text,
  historico     jsonb NOT NULL DEFAULT '[]',
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON pedidos_certificado (conta_id, criado_em DESC);
