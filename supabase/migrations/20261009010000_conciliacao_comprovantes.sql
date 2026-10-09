-- Comprovantes de pagamento anexados pelo robô de conciliação

alter table public.conciliacao_log
  add column if not exists comprovante_url text,
  add column if not exists anexo text;  -- ja_tinha | anexado | link | falta | erro

-- Bucket dos comprovantes. Público com caminho aleatório (UUID) para o link
-- funcionar dentro do Conta Azul; o upload só é feito pela Edge Function.
insert into storage.buckets (id, name, public, file_size_limit)
values ('comprovantes', 'comprovantes', true, 10485760)
on conflict (id) do nothing;
