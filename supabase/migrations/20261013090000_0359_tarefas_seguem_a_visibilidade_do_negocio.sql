-- ============================================================================
-- 0359 — A TAREFA SEGUE A VISIBILIDADE DO NEGÓCIO A QUE ESTÁ PRESA
--
-- Chega junto com as tarefas dentro do card do negócio (porte do PR #2760 de
-- melgarafael/DeskcommCRM, de @profpeque). Lá a mudança não toca o banco; aqui
-- toca, porque este fork tem o papel `provider` (prestador, que só vê o que é
-- dele) e o modo de visibilidade por atendente (`visibility_mode`, 0036).
--
-- ─── O defeito
--
-- A 0210 criou `crm_tasks` com leitura para a ORGANIZAÇÃO inteira. Enquanto a
-- tarefa só nascia na tela de Tarefas, avulsa, isso bastava. Com a tarefa
-- nascendo de dentro do card, o título passa a falar do cliente ("ligar para a
-- Maria sobre o orçamento do preenchimento"), e quem não enxerga o negócio lia
-- a tarefa dele por `GET /api/v1/tasks` ou direto pelo PostgREST: o prestador,
-- e o atendente em modo "só os seus". É o mesmo furo que a 0042 fechou em
-- `crm_lead_activities` e `crm_lead_links`.
--
-- ─── A regra
--
-- Dentro da organização, a sessão VÊ a tarefa quando:
--   1. é a responsável por ela (`assigned_to`). Tarefa dada a alguém que não
--      a enxerga seria trabalho que ninguém faz; ou
--   2. a tarefa é avulsa (`lead_id` nulo) e o papel não é `provider`. Avulsa é
--      lembrete da equipe; o prestador só vê o que é dele; ou
--   3. a sessão enxerga o negócio, pela MESMA `fn_can_view_lead` (0036) que
--      governa `crm_leads`, por `exists` no negócio da mesma organização (não
--      por valor do dono: negócio oculto devolveria nulo, e o modo
--      "própria e fila" trataria nulo como fila; lição da 0042).
--
-- ESCREVER continua sendo de `agent` para cima (0210), agora também limitado ao
-- que a sessão vê. A policy `crm_tasks_write` era `for all`, e o `using` de uma
-- `for all` vale para SELECT somado por OU: com ela de pé, todo `agent` leria
-- tudo e a regra acima não valeria para ninguém acima de `provider`. Por isso
-- ela sai e a escrita volta por comando. Criar exige enxergar o negócio (ser a
-- responsável não basta para pendurar tarefa em negócio alheio).
--
-- Nenhuma coluna, nenhum índice, nenhum dado mexido. O `exists` usa a chave
-- primária de `crm_leads`. Quem via tudo (gestor, administrador, somente
-- leitura) segue vendo tudo. Idempotente: pode ser reaplicada.
-- ============================================================================

drop policy if exists crm_tasks_write on public.crm_tasks;

drop policy if exists crm_tasks_select on public.crm_tasks;
create policy crm_tasks_select on public.crm_tasks
  for select using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and (assigned_to = (select auth.uid())
             or (lead_id is null and public.fn_user_role_in_org(organization_id) <> 'provider')
             or exists (select 1 from public.crm_leads l
                         where l.id = crm_tasks.lead_id
                           and l.organization_id = crm_tasks.organization_id
                           and public.fn_can_view_lead(l.organization_id, l.owner_user_id))))
  );

drop policy if exists crm_tasks_insert on public.crm_tasks;
create policy crm_tasks_insert on public.crm_tasks
  for insert with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent')
        and (lead_id is null
             or exists (select 1 from public.crm_leads l
                         where l.id = crm_tasks.lead_id
                           and l.organization_id = crm_tasks.organization_id
                           and public.fn_can_view_lead(l.organization_id, l.owner_user_id))))
  );

drop policy if exists crm_tasks_update on public.crm_tasks;
create policy crm_tasks_update on public.crm_tasks
  for update using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent')
        and (lead_id is null
             or assigned_to = (select auth.uid())
             or exists (select 1 from public.crm_leads l
                         where l.id = crm_tasks.lead_id
                           and l.organization_id = crm_tasks.organization_id
                           and public.fn_can_view_lead(l.organization_id, l.owner_user_id))))
  ) with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent')
        and (lead_id is null
             or assigned_to = (select auth.uid())
             or exists (select 1 from public.crm_leads l
                         where l.id = crm_tasks.lead_id
                           and l.organization_id = crm_tasks.organization_id
                           and public.fn_can_view_lead(l.organization_id, l.owner_user_id))))
  );

drop policy if exists crm_tasks_delete on public.crm_tasks;
create policy crm_tasks_delete on public.crm_tasks
  for delete using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent')
        and (lead_id is null
             or assigned_to = (select auth.uid())
             or exists (select 1 from public.crm_leads l
                         where l.id = crm_tasks.lead_id
                           and l.organization_id = crm_tasks.organization_id
                           and public.fn_can_view_lead(l.organization_id, l.owner_user_id))))
  );

notify pgrst, 'reload schema';
