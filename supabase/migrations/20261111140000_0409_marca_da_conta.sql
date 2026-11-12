-- Migration 0409 : ONDE MORA A ÚLTIMA MARCA BOA DA CONTA EVA LINK.
--
-- Plano 6 (marca central no CRM). O leitor `lib/branding/conta.ts` busca
-- `GET {CONTA_URL}/api/marca` e as logos; o que passou pelas conferências
-- (contraste, tipo da logo, sha256) é guardado aqui, na linha única da
-- instalação, para três usos:
--   - a renderização usa a última marca boa quando a Conta está fora;
--   - o worker de LGPD/e-mail (`marcaDaSaida`) lê do banco sem esperar a rede;
--   - o ETag permite perguntar "mudou?" com If-None-Match (304).
--
-- Colunas separadas das da marca local (`app_name`, `accent_hex`,
-- `logo_path`), de propósito: a marca local e o `.env` continuam sendo o piso.
-- Num clone que ainda não aplicou esta migration, ler `conta_*` dá 42703 e o
-- leitor degrada para a marca local — por isso a leitura dessas colunas é
-- separada da leitura das antigas.
--
--   conta_nome           nome da clínica (vira app_name na tela)
--   conta_accent_hex     cores.principal em minúsculas (semente da paleta)
--   conta_logo_path      platform/conta-<sha256>.(png|jpg) no bucket brand-logos
--   conta_logos          {escuro: sha|null, claro: sha|null} do que está guardado
--   conta_etag           ETag da última resposta 200 aceita
--   conta_atualizado_em  atualizado_em que a Conta anunciou
--   conta_lida_em        quando a última rodada aceita terminou
--   conta_icone_path     platform/conta-<sha256>.png — ícone da aba (Plano 7)
--
-- CHECKs com nome, criados só se faltarem (sem drop + add: reaplicar não deixa
-- a tabela sem a constraint nem por um comando). As colunas são novas, então
-- não há dado a corrigir; o `update` antes de cada CHECK fica pelo padrão
-- (o update.sh roda sem ON_ERROR_STOP e um clone pode ter rodado versão
-- anterior deste arquivo).
--
-- Nenhum GRANT novo: a tabela é só service_role (RLS ligada, zero policies,
-- revoke de anon/authenticated na 0155) e coluna nova herda isso. Nenhum
-- gatilho, nenhuma função nova.

alter table public.platform_branding
  add column if not exists conta_nome text,
  add column if not exists conta_accent_hex text,
  add column if not exists conta_logo_path text,
  add column if not exists conta_logos jsonb,
  add column if not exists conta_etag text,
  add column if not exists conta_atualizado_em timestamptz,
  add column if not exists conta_lida_em timestamptz,
  add column if not exists conta_icone_path text;

comment on column public.platform_branding.conta_nome is
  'Nome da clínica lido da Conta Eva Link (última marca boa). Vale acima de app_name quando presente. Escrito por lib/branding/conta.ts.';
comment on column public.platform_branding.conta_accent_hex is
  'cores.principal da Conta, #rrggbb minúsculo — semente da paleta. Última marca boa (passou no contraste).';
comment on column public.platform_branding.conta_logo_path is
  'Logo da Conta guardada em storage/brand-logos, sempre platform/conta-<sha256>.(png|jpg). Caminho e NÃO url (DIRC-C).';
comment on column public.platform_branding.conta_logos is
  'sha256 do que está guardado: {escuro, claro, icone} (sha|null). Comparado com o que a Conta anuncia para saber se precisa baixar.';
comment on column public.platform_branding.conta_icone_path is
  'Ícone da aba vindo da Conta (Plano 7), em storage/brand-logos, sempre platform/conta-<sha256>.png. Vence o ícone enviado e o desenhado.';
comment on column public.platform_branding.conta_etag is
  'ETag da última resposta aceita de /api/marca, mandado em If-None-Match.';
comment on column public.platform_branding.conta_atualizado_em is
  'atualizado_em anunciado pela Conta na última marca aceita (null = a Conta nunca foi configurada).';
comment on column public.platform_branding.conta_lida_em is
  'Quando a última rodada de leitura da Conta foi aceita.';

update public.platform_branding
   set conta_accent_hex = null
 where conta_accent_hex is not null
   and conta_accent_hex !~ '^#[0-9a-f]{6}$';

update public.platform_branding
   set conta_logo_path = null
 where conta_logo_path is not null
   and conta_logo_path !~ '^platform/conta-[0-9a-f]{64}\.(png|jpg)$';

update public.platform_branding
   set conta_icone_path = null
 where conta_icone_path is not null
   and conta_icone_path !~ '^platform/conta-[0-9a-f]{64}\.png$';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.platform_branding'::regclass
       and conname = 'platform_branding_conta_accent_hex'
  ) then
    alter table public.platform_branding
      add constraint platform_branding_conta_accent_hex check (
        conta_accent_hex is null or conta_accent_hex ~ '^#[0-9a-f]{6}$'
      );
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.platform_branding'::regclass
       and conname = 'platform_branding_conta_logo_path'
  ) then
    alter table public.platform_branding
      add constraint platform_branding_conta_logo_path check (
        conta_logo_path is null
        or conta_logo_path ~ '^platform/conta-[0-9a-f]{64}\.(png|jpg)$'
      );
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.platform_branding'::regclass
       and conname = 'platform_branding_conta_icone_path'
  ) then
    alter table public.platform_branding
      add constraint platform_branding_conta_icone_path check (
        conta_icone_path is null
        or conta_icone_path ~ '^platform/conta-[0-9a-f]{64}\.png$'
      );
  end if;
end $$;
