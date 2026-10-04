-- 0312 — anonimizar pela TELA também redige as notas internas da conversa
--
-- Correção própria deste fork (o projeto original ainda não cobre: o gatilho
-- de lá, até a 0497, também não toca `conversation_notes`).
--
-- A 0308 deixou `conversation_notes` (0303) fora do gatilho de propósito: o
-- pedido formal enfileira o anexo da nota sob o `request_id` do pedido (passo
-- 6d de `fn_lgpd_cascade_redact_contact`), e o gatilho não conhece o pedido.
-- Efeito: pelo botão da ficha (`fn_lgpd_anonymize_contact`) o texto da nota e
-- o arquivo no bucket `internal-media` sobreviviam à anonimização.
--
-- Por que um gatilho NOVO, e não mais um passo em
-- `fn_redigir_conversas_ao_anonimizar`: aquele gatilho dispara no passo 1 do
-- pedido formal, ANTES do 6d. Se ele zerasse o ponteiro da nota, o 6d não
-- acharia mais o caminho e o arquivo ficaria na fila SEM o `request_id` — o
-- que `tests/invariants/anexo-da-nota-interna-responde-a-lgpd.test.ts` proíbe.
-- Este é um CONSTRAINT TRIGGER `deferrable initially deferred`: roda no COMMIT
-- da transação que virou `is_anonymized`. No pedido formal o 6d já redigiu a
-- nota e enfileirou o anexo com o `request_id`, e aqui nada sobra para fazer;
-- pelo botão, é este gatilho que redige e enfileira (`request_id` nulo, como a
-- mídia das mensagens na 0308). Gatilho NÃO faz HTTP: só escreve em tabela; o
-- worker de storage drena a fila.
--
-- Mesmo critério do 6d: texto vira '[nota interna anonimizada]', as três
-- colunas de mídia zeram, e só entra na fila caminho sob o prefixo da própria
-- organização, sempre com bucket `internal-media`.

create or replace function public.fn_redigir_notas_internas_ao_anonimizar()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- O arquivo vai para a fila ANTES de o ponteiro ser zerado.
  insert into public.storage_redaction_queue (organization_id, bucket, object_path)
  select distinct new.organization_id, 'internal-media', n.media_storage_path
    from public.conversation_notes n
   where n.organization_id = new.organization_id
     and n.conversation_id in (
       select c.id from public.conversations c
        where c.contact_id = new.id and c.organization_id = new.organization_id)
     and n.media_storage_path is not null
     and length(n.media_storage_path) > 0
     and n.media_storage_path like new.organization_id::text || '/%'
  on conflict (bucket, object_path) do nothing;

  -- Guard: nota que o 6d (ou uma rodada anterior) já redigiu não é reescrita.
  update public.conversation_notes set
    body = '[nota interna anonimizada]',
    media_storage_path = null,
    media_mime = null,
    media_size_bytes = null
  where organization_id = new.organization_id
    and conversation_id in (
      select c.id from public.conversations c
       where c.contact_id = new.id and c.organization_id = new.organization_id)
    and (body is distinct from '[nota interna anonimizada]'
         or media_storage_path is not null
         or media_mime is not null
         or media_size_bytes is not null);

  return null;
end
$$;

-- As DUAS origens de EXECUTE: o grant a PUBLIC da criação e o grant nominal a
-- anon do ALTER DEFAULT PRIVILEGES do baseline.
revoke all on function public.fn_redigir_notas_internas_ao_anonimizar() from public;
revoke execute on function public.fn_redigir_notas_internas_ao_anonimizar() from anon;
revoke execute on function public.fn_redigir_notas_internas_ao_anonimizar() from authenticated;

drop trigger if exists trg_redigir_notas_internas_ao_anonimizar on public.contacts;
create constraint trigger trg_redigir_notas_internas_ao_anonimizar
  after update of is_anonymized on public.contacts
  deferrable initially deferred
  for each row
  when (new.is_anonymized = true and coalesce(old.is_anonymized, false) = false)
  execute function public.fn_redigir_notas_internas_ao_anonimizar();

-- Cura: contatos JÁ anonimizados (por qualquer caminho) antes deste gatilho.
-- Só alcança nota criada ATÉ `anonymized_at` (mesmo critério da 0308): quem
-- voltou a escrever tem nota NOVA, que a reaplicação do baseline no update.sh
-- não pode redigir. Idempotente: a fila tem `on conflict do nothing` e o
-- UPDATE só reescreve nota com resíduo. Fila antes do UPDATE.
insert into public.storage_redaction_queue (organization_id, bucket, object_path)
select distinct n.organization_id, 'internal-media', n.media_storage_path
  from public.conversation_notes n
  join public.conversations c
    on c.id = n.conversation_id and c.organization_id = n.organization_id
  join public.contacts k
    on k.id = c.contact_id and k.organization_id = c.organization_id
 where k.is_anonymized
   and n.created_at <= k.anonymized_at
   and n.media_storage_path is not null
   and length(n.media_storage_path) > 0
   and n.media_storage_path like n.organization_id::text || '/%'
on conflict (bucket, object_path) do nothing;

update public.conversation_notes n set
  body = '[nota interna anonimizada]',
  media_storage_path = null,
  media_mime = null,
  media_size_bytes = null
  from public.conversations c, public.contacts k
 where c.id = n.conversation_id
   and c.organization_id = n.organization_id
   and k.id = c.contact_id
   and k.organization_id = c.organization_id
   and k.is_anonymized
   and n.created_at <= k.anonymized_at
   and (n.body is distinct from '[nota interna anonimizada]'
        or n.media_storage_path is not null
        or n.media_mime is not null
        or n.media_size_bytes is not null);

notify pgrst, 'reload schema';
