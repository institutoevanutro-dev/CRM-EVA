-- Migration 0427 : A ESCRITA TARDIA DA IA SOBRE UM CONTATO ANONIMIZADO JÁ NASCE REDIGIDA.
--
-- Porte do efeito de melgarafael/DeskcommCRM#1958 (issue #1957 de lá). A
-- virada de `is_anonymized` já redige `lead_notes`, `ai_agent_runs.tool_calls`
-- e `lead_state` (0309, porte do #1973), e a transcrição (0307, #1989). Sobra a
-- escrita que chega DEPOIS da virada: o turno do agente que estava no ar grava
-- os argumentos das ferramentas, a memória e o próximo passo com o nome da
-- pessoa, e nada voltava a redigir (a cura do baseline só roda no update.sh).
-- No original quem fecha isso é a retomada diária em TypeScript; aqui é um
-- gatilho BEFORE nas três tabelas, que fecha na hora da escrita, nos dois
-- caminhos de anonimizar, sem varredura.
--
-- Quem voltou a escrever depois continua poupado (doutrina da 0308/0309):
--   * run criada DEPOIS de `anonymized_at` não é tocada;
--   * memória e estado só são redigidos nos 15 min seguintes à anonimização.
-- `contacts.social_identity` (passo 8 do original) não existe neste fork.
--
-- Idempotente (create or replace). Mesmo bloco no apêndice do baseline.

create or replace function public.fn_lgpd_redige_escrita_tardia_da_ia()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_anonimizado_em timestamptz;
begin
  select k.anonymized_at into v_anonimizado_em
    from public.contacts k
   where k.id = new.contact_id
     and k.organization_id = new.organization_id
     and k.is_anonymized;
  if v_anonimizado_em is null then
    return new;
  end if;

  if tg_table_name = 'ai_agent_runs' then
    -- A run que COMEÇOU antes da anonimização é do episódio anonimizado,
    -- termine quando terminar. Run nova (created_at depois) é de quem voltou.
    if new.created_at <= v_anonimizado_em then
      new.tool_calls := public.fn_lgpd_redigir_tool_calls(new.tool_calls);
    end if;
  elsif now() <= v_anonimizado_em + interval '15 minutes' then
    -- ponytail: memória e estado não guardam de qual run vieram; a janela de
    -- 15 min cobre o turno que estava no ar. Se um turno passar disso, ligar
    -- a escrita à run (run_id) em vez do relógio.
    if tg_table_name = 'lead_notes' then
      new.headline := '(anonimizado)';
      new.body := '(anonimizado)';
      new.embedding := null;
    elsif tg_table_name = 'lead_state' then
      new.next_action := null;
      new.qualification := '{}'::jsonb;
    end if;
  end if;
  return new;
end
$$;

-- As DUAS origens de EXECUTE: o grant a PUBLIC da criação e o grant nominal a
-- anon (e authenticated) do ALTER DEFAULT PRIVILEGES do baseline.
revoke all on function public.fn_lgpd_redige_escrita_tardia_da_ia() from public, anon, authenticated;

create or replace trigger trg_lgpd_redige_escrita_tardia_da_ia
  before insert or update of tool_calls on public.ai_agent_runs
  for each row
  when (new.contact_id is not null)
  execute function public.fn_lgpd_redige_escrita_tardia_da_ia();

create or replace trigger trg_lgpd_redige_escrita_tardia_da_ia
  before insert or update of headline, body, embedding on public.lead_notes
  for each row
  execute function public.fn_lgpd_redige_escrita_tardia_da_ia();

create or replace trigger trg_lgpd_redige_escrita_tardia_da_ia
  before insert or update of next_action, qualification on public.lead_state
  for each row
  execute function public.fn_lgpd_redige_escrita_tardia_da_ia();
