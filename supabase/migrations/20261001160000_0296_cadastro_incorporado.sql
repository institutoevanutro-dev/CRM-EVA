-- 0296 — Cadastro Incorporado (Embedded Signup v4): o App ID e o Configuration
-- ID da instalação. Nenhum dos dois é segredo (o App ID vai para o browser no
-- `FB.init`); o segredo continua em `app_secret_encrypted` (0257). Aditiva e
-- idempotente. A tabela já é server-side only (RLS sem policy, grants
-- revogados de anon/authenticated na 0257): coluna nova herda isso, e
-- `tests/invariants/cadastro-incorporado-colunas-sem-grant.test.ts` mede.
alter table public.platform_meta_app
  add column if not exists app_id text,
  add column if not exists es_config_id text;

comment on column public.platform_meta_app.app_id is
  'App ID do app da Meta desta instalação. Público (vai ao FB.init do browser). Piso de rollback: META_APP_ID.';
comment on column public.platform_meta_app.es_config_id is
  'Configuration ID da variação Embedded Signup (Facebook Login for Business › Configurations). Piso: META_ES_CONFIG_ID.';
