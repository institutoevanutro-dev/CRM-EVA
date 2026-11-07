-- Migration 0408 : INTERVALO MÍNIMO ENTRE RESPOSTAS DA IA, por agente.
-- Porte do projeto original (DeskcommCRM, PR #3940 de @vinicoretecnologia-svg; 9101 lá).
--
-- Até aqui o agente só tinha a janela de rajada da instalação: ela junta as
-- mensagens que chegam em seguida, mas não impede a IA de responder de novo logo
-- depois de ter respondido. `reply_min_interval_ms`:
--   - NULL (default) ou 0 = sem intervalo. Quem só atualiza não muda nada.
--   - 1..600000 = a IA só volta a responder à MESMA conversa depois de
--     `última resposta da IA (sent_via = 'ai') + intervalo`; o que chega no
--     meio-tempo é respondido junto. Teto de 10 min.
-- Quem decide é o TypeScript (`intervaloEfetivo` clampa até dado sujo); a
-- constraint é a cerca do banco. A trava de imutabilidade da versão publicada
-- passa a cobrir a coluna (mesma lista da última definição + a coluna nova).

alter table public.ai_agent_versions
  add column if not exists reply_min_interval_ms integer;

comment on column public.ai_agent_versions.reply_min_interval_ms is
  'Intervalo mínimo em ms entre uma resposta da IA e a próxima à mesma conversa. NULL ou 0 = sem intervalo; teto 600000 (10 min).';

alter table public.ai_agent_versions
  drop constraint if exists ai_agent_versions_reply_min_interval_ms_check;

alter table public.ai_agent_versions
  add constraint ai_agent_versions_reply_min_interval_ms_check
  check (reply_min_interval_ms is null or (reply_min_interval_ms >= 0 and reply_min_interval_ms <= 600000));

create or replace function fn_ai_agent_version_content_immutable() returns trigger
language plpgsql as $fn$
begin
  if old.status <> 'draft' and (
       new.system_prompt          is distinct from old.system_prompt
    or new.provider               is distinct from old.provider
    or new.model                  is distinct from old.model
    or new.credential_id          is distinct from old.credential_id
    or new.tool_ids               is distinct from old.tool_ids
    or new.trigger_config         is distinct from old.trigger_config
    or new.channel_session_id     is distinct from old.channel_session_id
    or new.max_steps              is distinct from old.max_steps
    or new.token_budget           is distinct from old.token_budget
    or new.cost_budget_cents      is distinct from old.cost_budget_cents
    or new.history_message_window is distinct from old.history_message_window
    or new.history_token_window   is distinct from old.history_token_window
    or new.handoff_keywords       is distinct from old.handoff_keywords
    or new.handoff_tool_enabled   is distinct from old.handoff_tool_enabled
    or new.followup               is distinct from old.followup
    or new.multimodal_input       is distinct from old.multimodal_input
    or new.video_frames_enabled   is distinct from old.video_frames_enabled
    or new.split_messages         is distinct from old.split_messages
    or new.split_max_chars        is distinct from old.split_max_chars
    or new.reply_min_interval_ms  is distinct from old.reply_min_interval_ms
    or new.cases_enabled          is distinct from old.cases_enabled
    or new.operator_enabled       is distinct from old.operator_enabled
    or new.operator_model         is distinct from old.operator_model
    or new.operator_tool_ids      is distinct from old.operator_tool_ids
    or new.pipeline_ids           is distinct from old.pipeline_ids
    or new.knowledge_source_ids   is distinct from old.knowledge_source_ids
    or new.version_number         is distinct from old.version_number
    or new.agent_id               is distinct from old.agent_id
    or new.organization_id        is distinct from old.organization_id
  ) then
    raise exception 'ai_agent_versions % é imutável (status=%): mudança de conteúdo = versão draft nova; rollback = revert (clona + publica)',
      old.id, old.status;
  end if;
  return new;
end;
$fn$;
