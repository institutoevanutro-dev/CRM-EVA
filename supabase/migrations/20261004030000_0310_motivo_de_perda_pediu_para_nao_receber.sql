-- 0310 — Motivo de perda próprio para quem responde PARAR.
-- Portado do projeto original (DeskcommCRM PR 2049 de @paulolimajr77, migration 0513 lá).
--
-- A ingestão (`lib/channels/pos-entrada.ts`) passa a fechar sozinha, como
-- perdido, todo negócio aberto do contato que pediu para não receber
-- mensagens. Com o motivo que existia (`requested_by_customer`, "Cliente
-- solicitou cancelamento") a tela diria algo que o cliente não pediu: pedir
-- silêncio não é cancelar. Motivo próprio: `opted_out_of_messages`
-- ("Pediu para não receber mensagens"). CONTA como perda.
--
-- O único lugar do banco que conhece os motivos canônicos é o array de
-- `fn_validate_lost_reason_required`; sem ele o trigger recusaria a perda com
-- 22023 `lost_reason_invalid` e o negócio ficaria aberto. Corpo idêntico ao
-- do baseline do fork, com o motivo novo no fim do array. Aditiva e idempotente.

create or replace function public.fn_validate_lost_reason_required() returns trigger
    language plpgsql
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_canonical text[] := array['requested_by_customer','price','no_response','product_unavailable',
                              'cancelled_by_store','cancelled_by_customer','payment_failed','other',
                              'opted_out_of_messages'];
  v_pipeline_extra text[];
begin
  if new.status = 'lost' then
    if new.lost_reason is null or length(new.lost_reason) = 0 then
      raise exception 'lost_reason_required' using errcode = '22023';
    end if;

    select coalesce(
      array(select jsonb_array_elements_text(settings->'lost_reasons')), '{}'::text[]
    ) into v_pipeline_extra
    from public.crm_pipelines where id = new.pipeline_id;

    if not (new.lost_reason = any (v_canonical) or new.lost_reason = any (v_pipeline_extra)) then
      raise exception 'lost_reason_invalid: %', new.lost_reason using errcode = '22023';
    end if;
  end if;
  return new;
end$$;

-- Função de trigger: o EXECUTE não é conferido no disparo, então tirar de
-- public/anon não muda quem consegue perder um negócio — só fecha a RPC.
revoke execute on function public.fn_validate_lost_reason_required() from public, anon;
grant execute on function public.fn_validate_lost_reason_required() to authenticated, service_role;
