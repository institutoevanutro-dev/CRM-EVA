-- 0356: o pedido do titular fecha o ciclo.
--
-- O bloco abaixo é o MESMO, letra a letra, do apêndice de `supabase/baseline.sql`:
-- é ele que o deploy reaplica a cada atualização.

-- ---- o pedido do titular fecha o ciclo (migration 0356) ----
-- Porte da 0651 de melgarafael/DeskcommCRM #2788 (@melgarafael).
--
-- O vocabulário de `lgpd_requests.status` no TypeScript (`lib/lgpd/types.ts`, os
-- filtros das rotas, as telas) sempre teve `pending_review`; o CHECK do banco
-- nunca teve. O `lgpd-export-worker` grava esse estado quando o relatório ficou
-- pronto e não há como entregar por e-mail (instalação sem transporte, ou
-- titular sem endereço), e o `lgpd-redact-worker` em dois desfechos (contato sem
-- pegada local; anonimização de organização com falha parcial). O banco recusava
-- com 23514, ninguém lia o erro, o worker auditava o desfecho que não aconteceu
-- e devolvia `ok` ao dreno: o pedido ficava em `processing` para sempre, com
-- `result` nulo e o PDF no bucket sem ponteiro. Enquanto isso a retenção de
-- mídia da organização ficava suspensa (ela pausa com pedido aberto).
--
-- 1. O CHECK passa a aceitar `pending_review`. Drop e add dentro do MESMO bloco
--    `do`: é um comando só, então reaplicar o baseline não deixa a tabela sem
--    guarda no meio (`tests/invariants/reaplicar-o-baseline-nao-abre-janela`),
--    e a troca é PULADA quando o CHECK já aceita o estado. Nenhum saneamento
--    antes do add: o conjunto novo só AMPLIA o velho.
--
-- 2. Os pedidos já presos são levados a `pending_review` com o `result` que o
--    worker teria gravado, e SÓ os que têm prova no `api_audit_log` da MESMA
--    organização. Antes desta migration nenhum update para `pending_review`
--    podia ter dado certo, e os caminhos que tentam auditam DEPOIS do update,
--    com o `resource_id` do pedido. Então: pedido em `processing`, com `result`
--    nulo e esse audit = pedido preso por este defeito. Os caminhos do PDF são
--    fixos no worker (`{org}/{pedido}/report.pdf|data.json`); `sha256`,
--    `signed_pades` e `delivered_to_hash` vêm do audit; o `warning` sai da regra
--    do assinador (`pades_key_missing` exatamente quando não assinado). Pedido
--    preso sem essa linha de audit (o audit é fire-and-forget) fica como está.
--
-- Reaplicável: depois da primeira passada os curados não estão mais em
-- `processing`. Não cria função, então fica antes da VARREDURA anon só por
-- ordem de apêndice.

do $$
declare
  v_exportacoes integer;
  v_sem_pegada integer;
  v_tenants integer;
begin
  -- 1. O CHECK passa a aceitar o estado que o código grava.
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.lgpd_requests'::regclass
       and conname = 'lgpd_requests_status_check'
       and pg_get_constraintdef(oid) like '%''pending_review''%'
  ) then
    alter table public.lgpd_requests drop constraint if exists lgpd_requests_status_check;
    alter table public.lgpd_requests add constraint lgpd_requests_status_check
      check (status = any (array['received'::text, 'processing'::text, 'completed'::text,
                                 'failed'::text, 'expired'::text, 'pending_review'::text]));
  end if;

  -- 2. Exportação presa: sem transporte de e-mail, ou titular sem endereço.
  with prova as (
    select distinct on (a.resource_id) a.resource_id, a.organization_id, a.metadata
      from public.api_audit_log a
     where a.action = 'lgpd.export_generated'
       and a.resource_type = 'lgpd_request'
       and (a.metadata->>'warning' = 'email_not_configured'
            or a.metadata->>'delivery' = 'pending_review_no_email')
     order by a.resource_id, a.created_at desc
  )
  update public.lgpd_requests r
     set status = 'pending_review',
         error_message = case when p.metadata->>'warning' = 'email_not_configured'
                              then 'email_not_configured' else 'no_delivery_email' end,
         result = jsonb_build_object(
                    'pdf_path', r.organization_id::text || '/' || r.id::text || '/report.pdf',
                    'json_path', r.organization_id::text || '/' || r.id::text || '/data.json',
                    'sha256', p.metadata->'sha256',
                    'signed_pades', p.metadata->'signed_pades',
                    'warning', case when (p.metadata->>'signed_pades')::boolean
                                    then null else 'pades_key_missing' end
                  )
                  || case when p.metadata->>'warning' = 'email_not_configured'
                          then jsonb_build_object('delivered_to_hash', p.metadata->'delivered_to_hash')
                          else '{}'::jsonb end
    from prova p
   where r.id = p.resource_id
     and r.organization_id = p.organization_id
     and r.request_type = 'data_request'
     and r.status = 'processing'
     and r.result is null;
  get diagnostics v_exportacoes = row_count;

  -- 3. Anonimização de contato sem pegada local.
  update public.lgpd_requests r
     set status = 'pending_review',
         error_message = 'no_local_footprint',
         result = jsonb_build_object('reason', 'no_local_footprint')
   where r.request_type in ('redact', 'store_redact')
     and r.status = 'processing'
     and r.result is null
     and exists (
       select 1
         from public.api_audit_log a
        where a.action = 'lgpd.redact_no_local_footprint'
          and a.resource_type = 'lgpd_request'
          and a.resource_id = r.id
          and a.organization_id = r.organization_id
     );
  get diagnostics v_sem_pegada = row_count;

  -- 4. Anonimização de organização com falha parcial.
  with prova as (
    select distinct on (a.resource_id) a.resource_id, a.organization_id, a.metadata, a.created_at
      from public.api_audit_log a
     where a.action = 'lgpd.tenant_redacted'
       and a.resource_type = 'lgpd_request'
       and a.metadata->>'partial_failure' = 'true'
     order by a.resource_id, a.created_at desc
  )
  update public.lgpd_requests r
     set status = 'pending_review',
         completed_at = p.created_at,
         error_message = 'partial_failure',
         cascaded_to = p.metadata->'aggregate_counts',
         result = jsonb_build_object(
                    'scope', 'tenant',
                    'processed', p.metadata->'processed',
                    'failed_contacts_count', p.metadata->'failed_count',
                    'aggregate_counts', p.metadata->'aggregate_counts',
                    'callback_status', p.metadata->'callback_status',
                    'organization_status', 'redacted'
                  )
    from prova p
   where r.id = p.resource_id
     and r.organization_id = p.organization_id
     and r.request_type in ('redact', 'store_redact')
     and r.status = 'processing'
     and r.result is null;
  get diagnostics v_tenants = row_count;

  raise notice '0356: pedidos presos levados a pending_review: exportacao %, sem pegada %, organizacao %',
    v_exportacoes, v_sem_pegada, v_tenants;
end $$;
