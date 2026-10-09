-- Assinatura recorrente via Asaas.
ALTER TABLE contas
  ADD COLUMN asaas_cliente_id    text,
  ADD COLUMN asaas_assinatura_id text UNIQUE,
  ADD COLUMN assinatura_status   text NOT NULL DEFAULT 'nenhuma'
    CHECK (assinatura_status IN ('nenhuma', 'aguardando_pagamento', 'ativa', 'atrasada', 'cancelada')),
  ADD COLUMN plano_contratado    text,
  ADD COLUMN pago_ate            timestamptz,
  ADD COLUMN atrasada_desde      timestamptz,
  ADD COLUMN motivo_suspensao    text;

-- Eventos de webhook já processados (o Asaas pode reenviar o mesmo evento).
CREATE TABLE asaas_eventos (
  id           text PRIMARY KEY,
  tipo         text NOT NULL,
  conta_id     uuid,
  payload      jsonb NOT NULL,
  recebido_em  timestamptz NOT NULL DEFAULT now()
);
