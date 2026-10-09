-- ═══ Janela de RESPOSTA separada da janela de DISPARO (0335) ═══
--
-- Porte de melgarafael/DeskcommCRM #1984 (upstream 0495, sem o rename das
-- colunas `reengajar_*` do PR #1983 fechado, que este fork nunca teve).
--
-- O agente passa a poder responder a quem escreveu fora do horário comercial
-- sem abrir junto o disparo em massa, a prospecção e a retomada de conversa
-- parada. As duas coisas eram regidas por UM par (`window_start_hour`/
-- `window_end_hour`), então abrir a resposta para 24h abria também o disparo.
--
-- Colunas soltas e não jsonb: `window_*_hour` é coluna desde a 0010 e a tela de
-- Conexões já os edita.
--
-- ⚠️ Sem DEFAULT: NULL = a resposta herda a janela de disparo, coluna a coluna,
-- que é o comportamento de antes. Quem só atualiza não muda de operação.
alter table public.channel_knobs
  add column if not exists resposta_start_hour smallint,
  add column if not exists resposta_end_hour smallint;

comment on column public.channel_knobs.resposta_start_hour is
  'Início da janela de RESPOSTA do agente (h, hora local da org). NULL = usa window_start_hour (comportamento anterior).';
comment on column public.channel_knobs.resposta_end_hour is
  'Fim da janela de RESPOSTA do agente (h, exclusivo; 24 = meia-noite). NULL = usa window_end_hour.';

-- 0..24. `end` pode ser 24 (meia-noite seguinte) porque `insideWindow` compara
-- `wall.h < end` e a hora local nunca passa de 23. O `drop ... if exists` antes
-- do `add` torna a migration reaplicável. Colunas novas e vazias: nenhum dado
-- viola a constraint, não há o que corrigir antes.
alter table public.channel_knobs
  drop constraint if exists channel_knobs_resposta_horas_validas;
alter table public.channel_knobs
  add constraint channel_knobs_resposta_horas_validas
  check (
    (resposta_start_hour is null or resposta_start_hour between 0 and 23)
    and (resposta_end_hour is null or resposta_end_hour between 1 and 24)
  );
