-- Controle de obrigações acessórias (painel obrigacoes.html + robô do Domínio)

create table if not exists public.obr_empresas (
  id text primary key,
  codigo_dominio integer,
  cnpj text,
  razao text,
  uf text,
  municipio text,
  ie text,
  regime text,
  responsavel text,
  obrigacoes jsonb not null default '[]'::jsonb,   -- códigos: ["EFD_ICMS_IPI","EFD_CONTRIB",...]
  vencimentos jsonb not null default '{}'::jsonb,  -- dia de vencimento próprio por obrigação: {"GIA": 18}
  ativo boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.obr_entregas (
  id text primary key,                 -- "<empresa_id>|<obrigacao>|<AAAA-MM>"
  empresa_id text references public.obr_empresas(id) on delete cascade,
  obrigacao text not null,
  competencia text not null,           -- AAAA-MM
  vencimento text,                     -- AAAA-MM-DD
  status text not null default 'pendente',
  -- pendente | importado | gerado | conferido | divergente | transmitido | erro | dispensada
  etapas jsonb not null default '{}'::jsonb,   -- {importacao:{status,em,detalhe}, geracao:{...}, conferencia:{...}, entrega:{...}}
  conferencia jsonb,                           -- resultado da conferência (apontamentos e resumo)
  arquivo text,
  recibo text,
  recibo_arquivo text,
  data_entrega text,
  responsavel text,
  observacao text,
  log jsonb not null default '[]'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists obr_entregas_competencia_idx on public.obr_entregas (competencia);
create index if not exists obr_entregas_empresa_idx on public.obr_entregas (empresa_id);

-- Mesmo modelo de acesso da tabela notificacoes_fiscais (acesso via função smart-handler).
alter table public.obr_empresas enable row level security;
alter table public.obr_entregas enable row level security;

drop policy if exists "acesso publico" on public.obr_empresas;
create policy "acesso publico" on public.obr_empresas for all using (true) with check (true);

drop policy if exists "acesso publico" on public.obr_entregas;
create policy "acesso publico" on public.obr_entregas for all using (true) with check (true);
