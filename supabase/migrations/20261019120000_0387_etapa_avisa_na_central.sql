-- Migration 0387 : A ETAPA PODE AVISAR A EQUIPE NA CENTRAL QUANDO UM NEGÓCIO ENTRA NELA.
--
-- Portado do projeto original (DeskcommCRM, PR #1813 de @jmpo; lá é a
-- migration 0440).
--
-- Marca por etapa, DESLIGADA por padrão: nada muda para quem não ligar. O
-- momento que pede ação da equipe nem sempre é o ganho (ex.: o paciente
-- confirmou os dados e alguém precisa preparar o atendimento); qual etapa é
-- essa é decisão da organização.
--
-- Quem lê: `lib/leads/aviso-de-etapa.handler.ts`, no evento
-- `lead.stage_changed`, que abre um item `other` / `ref_kind = lead` na
-- Central — só o nome da ETAPA no texto, nunca o nome ou o telefone do
-- paciente. A coluna é de `crm_stages`, que já é tenant-aware (organization_id
-- + RLS), e a mudança passa pela rota de edição da etapa, que audita.
--
-- Aditiva e idempotente: coluna com default, nenhuma linha a corrigir antes.
-- Sem função nova. No baseline, bloco antes da VARREDURA anon.
alter table public.crm_stages
  add column if not exists avisar_na_central boolean not null default false;

comment on column public.crm_stages.avisar_na_central is
  'Negócio que entra nesta etapa abre um aviso na Central de avisos (migration 0387).';

notify pgrst, 'reload schema';
