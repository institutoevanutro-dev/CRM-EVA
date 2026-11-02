-- Migration 0400 : CÓDIGO DE CLIQUE DO GOOGLE ADS NA MENSAGEM DO WHATSAPP.
--
-- Clique em anúncio do Google que abre o WhatsApp não carrega `gclid` até o
-- CRM, então nenhum contato nascia marcado como Google e nenhuma conversão
-- chegava à conta de anúncios. O site captura o id do clique, gera um código
-- curto, manda o par para `POST /api/v1/publico/clique-google/{token}` e põe
-- "Cód. ABC123" na mensagem pré-preenchida. Na mensagem recebida, o ingest
-- procura o código, consome a linha (uma vez só) e estampa o contato como
-- `google_ads` pelo caminho de primeiro toque que já existe (0164).
--
-- `ad_platform_connections.click_capture_token`: segredo de PATH (não é
-- credencial forte: o navegador o vê). Serve para a rota pública resolver a
-- organização sem confiar no corpo. Default aleatório (256 bits de dois
-- uuid v4), preenchido também nas linhas já existentes.
--
-- `google_click_codes`: só service_role, como `ad_platform_connections` (0213).
-- Sem função nova: nenhum grant de EXECUTE a revogar. Idempotente.
alter table public.ad_platform_connections
  add column if not exists click_capture_token text
  default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''));

update public.ad_platform_connections
   set click_capture_token = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
 where click_capture_token is null;

create unique index if not exists ad_platform_connections_click_capture_token_uk
  on public.ad_platform_connections (click_capture_token);

comment on column public.ad_platform_connections.click_capture_token is
  'Token de path da rota pública de captura de clique (POST /api/v1/publico/clique-google/{token}). Visível ao navegador: identifica a organização, não autentica ninguém (migration 0400).';

create table if not exists public.google_click_codes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  code text not null,
  click_id_kind text not null,
  click_id text not null,
  landing_url text,
  clicked_at timestamptz,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint google_click_codes_code_formato check (code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  constraint google_click_codes_kind_conhecido check (click_id_kind in ('gclid', 'gbraid', 'wbraid')),
  constraint google_click_codes_click_id_tamanho check (char_length(click_id) between 10 and 512)
);

create unique index if not exists google_click_codes_org_code_uk
  on public.google_click_codes (organization_id, code);
create index if not exists google_click_codes_created_at_idx
  on public.google_click_codes (created_at);

alter table public.google_click_codes enable row level security;
revoke all on public.google_click_codes from anon, authenticated;
grant select, insert, update, delete on public.google_click_codes to service_role;

comment on table public.google_click_codes is
  'Par código curto → id de clique do Google Ads, gravado pelo site no clique do WhatsApp e consumido uma vez quando a mensagem com "Cód. XXXXXX" chega. Vale 90 dias (migration 0400).';
