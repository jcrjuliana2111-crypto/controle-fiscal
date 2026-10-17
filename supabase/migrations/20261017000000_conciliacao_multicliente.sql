-- Robô de conciliação: vários clientes (uma conexão Conta Azul por cliente),
-- lançamentos criados a partir do extrato, ajustes (juros/desconto) e desfazer.

create table if not exists public.conta_azul_conexoes (
  cliente       text primary key,               -- identificador curto (slug)
  nome          text not null,                  -- nome exibido na tela
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table public.conta_azul_conexoes enable row level security;

-- a conexão que já existia vira o cliente "principal"
insert into public.conta_azul_conexoes (cliente, nome, access_token, refresh_token, expires_at, updated_at)
select 'principal', 'Cliente principal', access_token, refresh_token, expires_at, updated_at
from public.conta_azul_tokens where id = 1
on conflict (cliente) do nothing;

alter table public.conta_azul_oauth_state add column if not exists cliente text not null default 'principal';

alter table public.conciliacao_log
  add column if not exists cliente   text not null default 'principal',
  add column if not exists registro  text not null default 'baixa',  -- baixa | lancamento
  add column if not exists evento_id text,                            -- evento criado (lançamento)
  add column if not exists ajuste    jsonb,                           -- {tipo: juros|multa|desconto, valor}
  add column if not exists desfeito_em timestamptz;

-- trava contra baixa dupla passa a ser por cliente; baixa desfeita libera o movimento
drop index if exists public.conciliacao_log_fitid_ok_uidx;
create unique index if not exists conciliacao_log_cliente_fitid_ok_uidx
  on public.conciliacao_log (cliente, fitid) where status = 'ok';
create index if not exists conciliacao_log_cliente_created_idx
  on public.conciliacao_log (cliente, created_at desc);
