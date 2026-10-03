-- Filas executadas com service_role não aceitam comandos diretos de membros.
-- A leitura continua isolada por organização; rotas de escrita usam admin/definer.
revoke all on public.job_queue, public.storage_redaction_queue from public, anon, authenticated;
grant select on public.job_queue, public.storage_redaction_queue to authenticated;
grant all on public.job_queue, public.storage_redaction_queue to service_role;

drop policy if exists tenant_isolation_job_queue_all on public.job_queue;
drop policy if exists tenant_isolation_job_queue_select on public.job_queue;
create policy tenant_isolation_job_queue_select on public.job_queue
  for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));

drop policy if exists tenant_isolation_storage_redaction_queue_all on public.storage_redaction_queue;
drop policy if exists tenant_isolation_storage_redaction_queue_select on public.storage_redaction_queue;
create policy tenant_isolation_storage_redaction_queue_select on public.storage_redaction_queue
  for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));
