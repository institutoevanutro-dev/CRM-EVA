-- 0434: a agenda da Clinicorp também entra por WEBHOOK, começando pelo modo de captura.
--
-- ─── O caso ──────────────────────────────────────────────────────────────────
--
-- A cópia da 0433 lê `GET /appointment/list` com o "Usuário API" e o "Token
-- API". Esse acesso só existe com o módulo API Externa da Clinicorp (no site
-- deles, a seção "Integração via API" aparece com `Module_EXTERNAL_API = "X"`
-- ou plano PREMIUM). Uma clínica no plano Standard não o tem; o que ela tem é a
-- "Gestão de Webhook" (Gerenciar Assinatura › Acesso Externo e integrações), com
-- eventos de agendamento. O formato desse payload não tem documentação pública.
--
-- Então o receptor nasce MEDINDO: `app/api/v1/webhooks/clinicorp/[token]` guarda
-- só as CHAVES e os TIPOS do que chegou, nunca um valor, e o parser que grava a
-- ocupação é escrito depois, contra o formato medido.
--
-- ─── O que muda em `calendar_clinicorp_integrations` ─────────────────────────
--
-- * A credencial da API vira OPCIONAL: a clínica só de webhook tem a linha da
--   integração (o mapeamento e a ocupação dependem dela por FK) sem usuário nem
--   token. O CHECK novo diz que os dois andam juntos: metade de credencial não
--   existe. Linhas de antes têm os dois (eram NOT NULL), então o CHECK passa.
-- * `webhook_token_hash`: o sha256 (hex) do token do endereço. O token em claro
--   aparece UMA vez na tela, ao ser gerado, e nunca é gravado (mesma doutrina do
--   bearer: só o hash no banco). Único: é por ele que o receptor acha a
--   organização, nunca pelo corpo.
-- * `webhook_last_received_at`: a última batida com token válido.
-- * `webhook_formatos`: os formatos distintos recebidos (caminho → tipo), no
--   máximo 20. Sem valor nenhum: nome, telefone e observação do paciente nunca
--   entram (`lib/agenda/clinicorp/formato.ts`).
--
-- Nenhuma função nova. A tabela já nega tudo a `anon` e `authenticated` (0433),
-- e as colunas novas herdam isso.

alter table public.calendar_clinicorp_integrations
  alter column api_user drop not null,
  alter column api_token_encrypted drop not null;

alter table public.calendar_clinicorp_integrations
  add column if not exists webhook_token_hash text,
  add column if not exists webhook_last_received_at timestamptz,
  add column if not exists webhook_formatos jsonb not null default '[]'::jsonb;

do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'calendar_clinicorp_credencial_inteira') then
    alter table public.calendar_clinicorp_integrations
      add constraint calendar_clinicorp_credencial_inteira
      check ((api_user is null) = (api_token_encrypted is null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'calendar_clinicorp_webhook_token_hash_formato') then
    alter table public.calendar_clinicorp_integrations
      add constraint calendar_clinicorp_webhook_token_hash_formato
      check (webhook_token_hash is null or webhook_token_hash ~ '^[0-9a-f]{64}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'calendar_clinicorp_webhook_formatos_lista') then
    alter table public.calendar_clinicorp_integrations
      add constraint calendar_clinicorp_webhook_formatos_lista
      check (jsonb_typeof(webhook_formatos) = 'array');
  end if;
end $c$;

create unique index if not exists calendar_clinicorp_integrations_webhook_token_hash_key
  on public.calendar_clinicorp_integrations (webhook_token_hash);

comment on column public.calendar_clinicorp_integrations.webhook_token_hash is
  'Migration 0434: sha256 (hex) do token do endereço do webhook da Clinicorp. O token em claro só aparece na tela ao ser gerado; nunca é gravado.';
comment on column public.calendar_clinicorp_integrations.webhook_formatos is
  'Migration 0434: os formatos distintos que o webhook da Clinicorp mandou (caminho → tipo), no máximo 20. Nunca um valor do payload.';

notify pgrst, 'reload schema';
