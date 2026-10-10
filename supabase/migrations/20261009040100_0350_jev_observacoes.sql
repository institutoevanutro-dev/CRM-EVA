-- ============================================================================
-- 0350 — AS OBSERVAÇÕES DO JEV (fase 1, só observando)
--
-- Porte da 0421 de melgarafael/DeskcommCRM (#1696, a845f890). Uma linha por
-- resposta do Jev ao lado do que o mecanismo de hoje decidiu: só rótulos,
-- probabilidades e ponteiros — nunca texto de cliente. Diferenças do upstream:
-- a restritiva `mfa_provada` (a policy de tenancy é só de leitura, como no
-- upstream: ALL só-tenancy é dívida de RBAC proibida para tabela nova).
--
-- Idempotente; sem BEGIN/COMMIT. A função de expurgo nasce revogada de
-- public, anon e authenticated, executável só pelo service_role.
-- ============================================================================

create table if not exists public.jev_observacoes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- `TAREFAS_DO_JEV` (lib/ai/decisao/config.ts). Vocabulário ABERTO, sem CHECK.
  tarefa text not null,
  estado text not null
    constraint jev_observacoes_estado_check check (estado in ('observando', 'decidindo')),
  -- Ponteiros SEM FK de propósito: FK travaria a anonimização ou apagaria a
  -- observação com o histórico, e a linha não guarda nada da pessoa.
  conversation_id uuid,
  message_id uuid,
  job_id uuid,
  rotulo_jev text,
  probabilidade_jev numeric,
  confianca_jev numeric,
  -- O que o mecanismo de hoje decidiu. NULL = não decidiu: sem par.
  rotulo_atual text,
  concordou boolean generated always as (
    case when rotulo_jev is null or rotulo_atual is null then null
         else rotulo_jev = rotulo_atual end
  ) stored,
  modelo text,
  latencia_ms integer,
  created_at timestamptz not null default now()
);

comment on table public.jev_observacoes is
  'O Jev ao lado do mecanismo de hoje, tarefa a tarefa: o rótulo de cada um e se concordaram. Sem texto de cliente. Escrita só pelo servidor (lib/ai/decisao/registro.ts); lida pelo cartão do Jev (GET /api/v1/ai/jev). Expurgada por fn_expurgar_observacoes_do_jev (cron data-retention).';

create index if not exists jev_observacoes_org_tarefa_criada_idx
  on public.jev_observacoes (organization_id, tarefa, created_at desc);
create index if not exists jev_observacoes_criada_idx
  on public.jev_observacoes (created_at);
-- Uma resposta por tarefa e mensagem: o retry do evento não conta em dobro.
create unique index if not exists jev_observacoes_uma_por_mensagem_idx
  on public.jev_observacoes (organization_id, tarefa, message_id)
  where message_id is not null;

-- Membro da organização lê; ninguém pela REST escreve (o servidor passa por
-- cima da RLS com a service key).
alter table public.jev_observacoes enable row level security;
-- SÓ select: uma policy ALL só de tenancy é dívida de RBAC proibida para
-- tabela nova (tests/invariants/rbac-config-ia-canais.test.ts).
drop policy if exists tenant_isolation_jev_observacoes_all on public.jev_observacoes;
drop policy if exists tenant_isolation_jev_observacoes_select on public.jev_observacoes;
create policy tenant_isolation_jev_observacoes_select on public.jev_observacoes
  for select using (organization_id in (select public.fn_user_org_ids()));
drop policy if exists mfa_provada on public.jev_observacoes;
create policy mfa_provada on public.jev_observacoes as restrictive for all to authenticated
  using ((select public.fn_session_mfa_proven())) with check ((select public.fn_session_mfa_proven()));

revoke all on public.jev_observacoes from public, anon, authenticated;
grant select on public.jev_observacoes to authenticated;
grant all on public.jev_observacoes to service_role;

-- O prazo: padrão 90 dias (JEV_OBSERVACOES_RETENTION_DAYS), piso 30 NO CORPO,
-- para valer contra qualquer chamador. Sem seletor de linha além da idade.
create or replace function public.fn_expurgar_observacoes_do_jev(
  p_retencao_dias int default null,
  p_limite int default null
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dias int := greatest(coalesce(p_retencao_dias, 90), 30);
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 10000);
  v_apagadas int;
begin
  with vencidas as (
    select o.id from public.jev_observacoes o
     where o.created_at < now() - make_interval(days => v_dias)
     order by o.created_at
     limit v_limite
  )
  delete from public.jev_observacoes o using vencidas v where o.id = v.id;
  get diagnostics v_apagadas = row_count;
  return v_apagadas;
end;
$$;
revoke execute on function public.fn_expurgar_observacoes_do_jev(int, int) from public, anon, authenticated;
grant execute on function public.fn_expurgar_observacoes_do_jev(int, int) to service_role;

notify pgrst, 'reload schema';
