-- 0309 — a virada de is_anonymized alcança também lead_notes, ai_agent_runs.tool_calls e lead_state
--
-- Portado do projeto original (DeskcommCRM PR 1973 de @webtecnica, migration
-- 0494 de lá). Neste fork NENHUM caminho de anonimização tocava essas fontes —
-- nem o pedido formal, nem o botão da ficha, nem `lib/lgpd/cascata.ts`:
--
--   lead_notes.headline / body / embedding        memória da IA sobre o contato
--   ai_agent_runs.tool_calls                      texto do modelo, argumentos e resultados das ferramentas
--   lead_state.next_action / qualification        texto livre sobre o negócio
--
-- O conserto entra no gatilho da 0308 (`fn_redigir_conversas_ao_anonimizar`),
-- que os dois caminhos cruzam por construção. `create or replace` troca o corpo
-- INTEIRO: o corpo abaixo é o da 0308, byte a byte, mais os três passos.
--
-- Diferenças para o original:
--   * `contacts.social_identity` e as mensagens de grupo (0482 de lá) ficam de
--     fora: a coluna, `fn_telefone_variantes` e `metadata.group_sender` não
--     existem neste fork.
--   * `fn_lgpd_redigir_tool_calls` não tem espelho TypeScript aqui
--     (`redigirToolCalls` do #1958 não foi portado); é tolerante a forma
--     inesperada (não-array, passo não-objeto).
--   * Há cura dos já anonimizados, limitada a `anonymized_at` (o original não tinha).

-- Transformação pura de `ai_agent_runs.tool_calls` (forma de
-- lib/ai/runtime/serialize.ts): cada passo vira
-- `{ step?, tool_name?, redacted: true, tool_calls: [{ tool_name }] }`.
-- Fica QUAIS ferramentas rodaram e em que passo; sai o texto do modelo, os
-- argumentos e os resultados. Não é security definer; o único chamador é o
-- gatilho abaixo.
create or replace function public.fn_lgpd_redigir_tool_calls(p_tool_calls jsonb)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $t$
  select coalesce(jsonb_agg(t.step_json order by t.ord), '[]'::jsonb)
    from (
      select jsonb_strip_nulls(jsonb_build_object(
               'step', case when jsonb_typeof(s.step -> 'step') = 'number'
                            then (s.step ->> 'step')::jsonb end,
               'tool_name', case when jsonb_typeof(s.step -> 'tool_name') = 'string'
                                 then to_jsonb(s.step ->> 'tool_name') end,
               'redacted', true,
               'tool_calls', coalesce((
                 select jsonb_agg(jsonb_build_object('tool_name', coalesce(c ->> 'tool_name', 'unknown')))
                   from jsonb_array_elements(
                          case when jsonb_typeof(s.step -> 'tool_calls') = 'array'
                               then s.step -> 'tool_calls' else '[]'::jsonb end) c
                  where jsonb_typeof(c) = 'object'
               ), '[]'::jsonb)
             )) as step_json,
             s.ord
        from jsonb_array_elements(
               case when jsonb_typeof(p_tool_calls) = 'array' then p_tool_calls else '[]'::jsonb end
             ) with ordinality s(step, ord)
    ) t;
$t$;

revoke execute on function public.fn_lgpd_redigir_tool_calls(jsonb) from public, anon, authenticated;

create or replace function public.fn_redigir_conversas_ao_anonimizar()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.storage_redaction_queue (organization_id, bucket, object_path)
  select distinct new.organization_id, 'whatsapp-media', m.media_storage_path
    from public.messages m
   where m.organization_id = new.organization_id
     and m.conversation_id in (
       select c.id from public.conversations c
        where c.contact_id = new.id and c.organization_id = new.organization_id)
     and m.media_storage_path is not null
     and length(m.media_storage_path) > 0
  on conflict (bucket, object_path) do nothing;

  update public.messages set
    body = '[mensagem anonimizada]',
    media_url = null,
    media_mime = null,
    media_size_bytes = null,
    media_storage_path = null,
    media_derived_text = null,
    metadata = '{}'::jsonb,
    updated_at = now()
  where organization_id = new.organization_id
    and conversation_id in (
      select c.id from public.conversations c
       where c.contact_id = new.id and c.organization_id = new.organization_id);

  update public.conversations set
    metadata = '{}'::jsonb,
    last_message_preview = null,
    last_handoff_reason = null,
    updated_at = now()
  where contact_id = new.id and organization_id = new.organization_id;

  update public.lead_checkpoints set
    rolling_summary = '[resumo anonimizado]',
    commitments = '[]'::jsonb,
    objections = '[]'::jsonb,
    next_action = null,
    declaracao = null
  where contact_id = new.id and organization_id = new.organization_id;


  -- ── 0309 — lead_notes: a memória do agente sobre o contato ───────────────
  update public.lead_notes set
    headline = '(anonimizado)',
    body = '(anonimizado)',
    embedding = null,
    updated_at = now()
  where organization_id = new.organization_id
    and contact_id = new.id
    and (headline is distinct from '(anonimizado)'
         or body is distinct from '(anonimizado)'
         or embedding is not null);

  -- ── 0309 — ai_agent_runs.tool_calls: fica o NOME da ferramenta, sai o resto
  -- (texto do modelo, argumentos, resultados). Guard: só passo sem `redacted`,
  -- então o `[]` de nascença e a run já redigida não são tocados.
  update public.ai_agent_runs set
    tool_calls = public.fn_lgpd_redigir_tool_calls(ai_agent_runs.tool_calls)
  where ai_agent_runs.organization_id = new.organization_id
    and ai_agent_runs.contact_id = new.id
    and jsonb_typeof(ai_agent_runs.tool_calls) = 'array'
    and exists (
      select 1 from jsonb_array_elements(ai_agent_runs.tool_calls) s
       where jsonb_typeof(s) <> 'object' or (s->>'redacted') is distinct from 'true'
    );

  -- ── 0309 — lead_state: próxima ação e qualificação (texto livre) ─────────
  update public.lead_state set
    next_action = null,
    qualification = '{}'::jsonb,
    updated_at = now()
  where organization_id = new.organization_id
    and contact_id = new.id
    and (next_action is not null
         or coalesce(qualification, '{}'::jsonb) <> '{}'::jsonb);

  return new;
end
$$;

-- As DUAS origens de EXECUTE: o grant a PUBLIC da criação e o grant nominal a
-- anon do ALTER DEFAULT PRIVILEGES do baseline.
revoke all on function public.fn_redigir_conversas_ao_anonimizar() from public;
revoke execute on function public.fn_redigir_conversas_ao_anonimizar() from anon;
revoke execute on function public.fn_redigir_conversas_ao_anonimizar() from authenticated;

drop trigger if exists trg_redigir_conversas_ao_anonimizar on public.contacts;
create trigger trg_redigir_conversas_ao_anonimizar
  after update of is_anonymized on public.contacts
  for each row
  when (new.is_anonymized = true and coalesce(old.is_anonymized, false) = false)
  execute function public.fn_redigir_conversas_ao_anonimizar();

-- Cura: contatos JÁ anonimizados (por qualquer caminho) antes deste gatilho.
-- Cada comando só alcança o que existia ATÉ `anonymized_at` — quem voltou a
-- escrever tem memória/run/estado NOVOS, que a reaplicação do baseline no
-- update.sh não pode redigir. Idempotente: só reescreve linha com resíduo.
update public.lead_notes n set
  headline = '(anonimizado)',
  body = '(anonimizado)',
  embedding = null,
  updated_at = now()
  from public.contacts k
 where k.id = n.contact_id
   and k.organization_id = n.organization_id
   and k.is_anonymized
   and n.created_at <= k.anonymized_at
   and (n.headline is distinct from '(anonimizado)'
        or n.body is distinct from '(anonimizado)'
        or n.embedding is not null);

update public.ai_agent_runs r set
  tool_calls = public.fn_lgpd_redigir_tool_calls(r.tool_calls)
  from public.contacts k
 where k.id = r.contact_id
   and k.organization_id = r.organization_id
   and k.is_anonymized
   and r.created_at <= k.anonymized_at
   and jsonb_typeof(r.tool_calls) = 'array'
   and exists (
     select 1 from jsonb_array_elements(r.tool_calls) s
      where jsonb_typeof(s) <> 'object' or (s->>'redacted') is distinct from 'true'
   );

update public.lead_state l set
  next_action = null,
  qualification = '{}'::jsonb,
  updated_at = now()
  from public.contacts k
 where k.id = l.contact_id
   and k.organization_id = l.organization_id
   and k.is_anonymized
   and l.updated_at <= k.anonymized_at
   and (l.next_action is not null
        or coalesce(l.qualification, '{}'::jsonb) <> '{}'::jsonb);

notify pgrst, 'reload schema';
