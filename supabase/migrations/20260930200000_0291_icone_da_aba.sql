-- 0291 — O ícone da aba da instalação vira ARQUIVO enviado pela tela.
--
-- Até aqui o `/icon` era DESENHADO (app/icon.tsx): o símbolo do produto, ou a
-- cor + a inicial do nome configurado. Quem tem um símbolo próprio (uma folha,
-- um monograma) não tinha como pô-lo na aba — e a aba é o que fica entre os
-- favoritos e as abas abertas ao lado dos outros sistemas da clínica.
--
-- O arquivo mora no MESMO bucket `brand-logos` da 0158 e no MESMO formato de
-- caminho (`platform/<uuid v4>.png`), por dois motivos medidos:
--   - o invariante `tests/invariants/marca-logo.test.ts` vigia o bucket inteiro
--     (zero policy em storage.objects, caminho não-enumerável) — um prefixo
--     novo pediria uma segunda exceção para o mesmo bucket público;
--   - `podeApagar()` (lib/branding/logo-arquivo.ts) já confina o delete ao
--     prefixo `platform/`, então a rota do ícone não abre porta de apagar logo
--     de organização.
-- Só PNG: favicon em JPG não tem transparência, e a decisão de tipo é pelos
-- BYTES (farejarTipo), nunca pelo header — a mesma régua da 0158.
--
-- Grava-se o CAMINHO, nunca a URL (DIRC-C), como o logo_path.
-- Backfill ANTES da constraint: o update.sh roda sem ON_ERROR_STOP.
-- Aditiva e idempotente.

alter table public.platform_branding
  add column if not exists icone_path text;

comment on column public.platform_branding.icone_path is
  'Caminho do ícone da aba (favicon) em storage/brand-logos, sempre platform/<uuid>.png. Caminho e NÃO url (DIRC-C). Lido por app/icon.tsx, que serve os bytes; sem ele, o ícone é desenhado (símbolo do produto ou cor + inicial). Escrito por app/api/v1/marca/icone/route.ts.';

update public.platform_branding
   set icone_path = null
 where icone_path is not null
   and icone_path !~ '^platform/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$';

alter table public.platform_branding
  drop constraint if exists platform_branding_icone_path;
alter table public.platform_branding
  add constraint platform_branding_icone_path check (
    icone_path is null
    or icone_path ~ '^platform/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$'
  );
