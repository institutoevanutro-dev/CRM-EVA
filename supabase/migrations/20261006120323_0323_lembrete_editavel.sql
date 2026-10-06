-- 20261006120323_0323_lembrete_editavel.sql
-- 0323 — lembrete da agenda: o texto no tipo e a régua da remarcação.
--
-- Spec: docs/superpowers/specs/2026-10-06-lembrete-editavel-design.md.
--
-- (1) A REMARCAÇÃO CARIMBA QUANDO O HORÁRIO FOI MARCADO. Porte da 0536 do
-- DeskcommCRM original (9e5027f1f, issue #2230), com o corpo SQL idêntico.
--
-- O DEFEITO, medido na issue: a régua do degrau vencido na marcação é
-- `calendar_appointments.created_at`, e `created_at` não muda quando a reunião é
-- REMARCADA. Reunião criada 3 dias antes e remarcada às 18:30 para as 16h do dia
-- seguinte mantém a véspera (1440 min) "vencida desde 16:00 de hoje", e a
-- primeira varredura depois da remarcação manda o aviso — o defeito da #2223 com
-- outro gatilho.
--
-- As duas alternativas da issue, medidas antes de escolher:
--
--   - `updated_at`: não serve. O link do Meet e cada revisão reescrevem a linha,
--     e descartaria degraus ARMADOS quando o link ficasse pronto dentro da
--     última hora antes da reunião — sumindo com o lembrete em silêncio.
--   - `revision_started_at`: também não. Ele vira quando `starts_at`, `ends_at`,
--     `status`, `contact_id` ou `conversation_id` mudam. Confirmar um compromisso
--     já dentro de 24h reposicionaria a régua para DEPOIS da hora da véspera e
--     mataria o degrau armado.
--
-- O carimbo mora num GATILHO, e não no handler de remarcação: a remarcação
-- entra pela tela, por `crm_reschedule_appointment` da ferramenta MCP e pela
-- reconciliação do Google em `fn_appointment_change_core`, e o gatilho é o
-- único ponto que não depende de quem escreve lembrar de gravar.
--
-- O guard é `is distinct from`: `fn_appointment_change` monta o SET com
-- `case when p_patch?'starts_at' then … else starts_at end`, ou seja, SEMPRE
-- nomeia a coluna. Nomear não é mudar; sem o guard todo UPDATE de nota ou de
-- status reposicionaria a régua e mataria a véspera armada.
--
-- Sem backfill: linha nunca remarcada fica `NULL` e o leitor
-- (`app/api/v1/cron/agenda-reminder/route.ts`) cai em `created_at`, que é o
-- comportamento de antes.
--
-- (2) O COMENTÁRIO DE `reminder_sent_at` DEIXA DE MENTIR. A 0254 o chamou de
-- "informativo". Desde o rearme da remarcação (portes de 5c6c8d6f3 e e174c8484)
-- ele decide: é o instante contra o qual um degrau já carimbado volta a ser
-- candidato. E é gravado ANTES do envio (porte de 6ed38c78c). Continua NÃO sendo
-- filtro de quem recebe.
--
-- (3) O TEXTO DO LEMBRETE MORA NO TIPO. Porte da 0265 do original (6146539da),
-- com o mesmo nome de coluna para um merge futuro não conflitar:
-- `calendar_event_types.reminder_body`, nullable, sem backfill. NULL = a frase
-- padrão do cron, o comportamento de antes. DIRC: a frase é do MOLDE, não do
-- compromisso marcado e não de `message_templates` (scripts do inbox). Mudar o
-- texto do tipo não reescreve o que já saiu. As variáveis deste fork são mais
-- que as do original; a lista é `VARIAVEIS_DO_LEMBRETE`.
--
-- Idempotente: `add column if not exists`, `create or replace`, `drop trigger if
-- exists`, `comment on` (repetir não muda nada).
-- ---- lembrete editável e régua da remarcação (migration 0323) ----
alter table public.calendar_appointments
  add column if not exists starts_at_marked_at timestamptz;

comment on column public.calendar_appointments.starts_at_marked_at is
  'Instante em que o starts_at ATUAL foi gravado — a régua do degrau de lembrete vencido na marcação (#2223) depois de uma remarcação (#2230). NULL = a linha nunca foi remarcada; quem lê (a rota agenda-reminder) cai em created_at.';

create or replace function public.fn_starts_at_marked_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.starts_at is distinct from old.starts_at then
    new.starts_at_marked_at := clock_timestamp();
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_starts_at_marked_at() from public, anon, authenticated;
grant execute on function public.fn_starts_at_marked_at() to service_role;

drop trigger if exists trg_starts_at_marked_at on public.calendar_appointments;
create trigger trg_starts_at_marked_at
  before update of starts_at on public.calendar_appointments
  for each row execute function public.fn_starts_at_marked_at();

comment on column public.calendar_appointments.reminder_sent_at is
  'Instante do último carimbo de lembrete, gravado ANTES do envio. Depois de uma remarcação é a régua do rearme: um degrau já carimbado volta a ser candidato quando o alvo novo dele fica meio intervalo ou mais depois deste instante. NÃO é filtro de quem recebe; o que já saiu é reminder_sent_offsets_minutes.';

alter table public.calendar_event_types
  add column if not exists reminder_body text;

comment on column public.calendar_event_types.reminder_body is
  'Texto do lembrete no WhatsApp. NULL = a frase padrão do cron. Variáveis {{primeiro_nome}}, {{nome}}, {{quando}}, {{data}}, {{hora}}, {{dia_semana}}, {{unidade}}, {{endereco}}, {{profissional}}, {{tipo}}, {{titulo}}, {{dia}}; a lista mora em lib/agenda/texto-do-lembrete.ts. Distinto de reminder_template_name, o modelo legado, que sai cru.';
