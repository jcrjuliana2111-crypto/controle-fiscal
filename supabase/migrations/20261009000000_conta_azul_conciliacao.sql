-- Robô de conciliação Conta Azul
-- Tabelas acessadas só pela Edge Function "conta-azul" (service role).
-- RLS ligado e sem políticas = ninguém de fora lê os tokens.

create table if not exists public.conta_azul_tokens (
  id            int primary key default 1 check (id = 1),
  access_token  text not null,
  refresh_token text not null,
  expires_at    timestamptz not null,
  updated_at    timestamptz not null default now()
);

create table if not exists public.conta_azul_oauth_state (
  state      text primary key,
  created_at timestamptz not null default now()
);

create table if not exists public.conciliacao_log (
  id               bigint generated always as identity primary key,
  fitid            text not null,          -- id do movimento no extrato
  parcela_id       text not null,          -- parcela do Conta Azul
  tipo             text not null,          -- receber | pagar
  data             date not null,
  valor            numeric(14,2) not null,
  conta_financeira text not null,
  historico        text,
  status           text not null,          -- ok | erro
  baixa_id         text,
  erro             text,
  created_at       timestamptz not null default now()
);
create index if not exists conciliacao_log_fitid_idx on public.conciliacao_log (fitid);
create unique index if not exists conciliacao_log_fitid_ok_uidx on public.conciliacao_log (fitid) where status = 'ok';

alter table public.conta_azul_tokens      enable row level security;
alter table public.conta_azul_oauth_state enable row level security;
alter table public.conciliacao_log        enable row level security;
