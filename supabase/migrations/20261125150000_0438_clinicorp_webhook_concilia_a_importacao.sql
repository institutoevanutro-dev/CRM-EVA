-- 0438: o webhook da Clinicorp grava a ocupação, e o que ele traz SUBSTITUI a
-- foto importada do mesmo horário.
--
-- ─── O caso ──────────────────────────────────────────────────────────────────
--
-- A clínica sem o módulo API Externa recebe a agenda por webhook (0434). O
-- formato foi medido em 25/11/2026 pelo modo de captura: o evento traz o MESMO
-- documento da API (`id`, `AtomicDate`, `fromTime`/`toTime`, `Dentist_PersonId`,
-- `Clinic_BusinessId`, `Canceled`, `Deleted`), e o receptor passa a gravá-lo por
-- `fn_agenda_clinicorp_gravar` (0433), sem mudança nela.
--
-- O que já estava marcado entrou pela importação do relatório (0435), numa
-- tabela à parte e SEM id da Clinicorp. Quando o webhook fala de um desses
-- horários (confirmou, remarcou, desmarcou), o mesmo compromisso passaria a
-- existir duas vezes: na foto e na cópia. A tela desenharia dois blocos, e o
-- desmarcado continuaria ocupando pela foto.
--
-- ─── A conciliação ───────────────────────────────────────────────────────────
--
-- `fn_agenda_clinicorp_conciliar(org)` apaga da foto o horário que a cópia já
-- conhece: mesma PESSOA (pelo profissional ligado a ela) e mesmo COMEÇO, em
-- qualquer situação. Desmarcado inclusive: é assim que o horário vaga. Depois
-- disso, quem manda naquele compromisso é a cópia, que tem o id.
--
-- Roda a organização inteira, e por isso não depende da ordem: o receptor chama
-- depois de gravar o evento, a tela chama depois de ligar profissional a pessoa
-- (o evento que chegou antes da ligação ainda não tinha pessoa) e a importação
-- chama depois de gravar a foto nova (a foto traz de volta o que a cópia já tem).
--
-- O que ela NÃO resolve, de propósito: o compromisso importado cujo primeiro
-- evento é uma remarcação. O evento traz o horário antigo (`OldfromTime`) sem o
-- dia antigo, e apagar "o mesmo horário no dia novo" acertaria a consulta de
-- outro paciente. O horário antigo segue ocupado até a próxima importação: o
-- lado seguro.
--
-- Função nova, e nenhuma existente muda: não abre janela na reaplicação do
-- baseline.

create or replace function public.fn_agenda_clinicorp_conciliar(p_org uuid)
returns integer
language sql
volatile
set search_path = public
as $$
  with apagados as (
    delete from public.calendar_clinicorp_imported_events m
     using public.calendar_clinicorp_events e
      join public.calendar_clinicorp_professionals p
        on p.organization_id = e.organization_id
       and p.professional_id = e.professional_id
     where m.organization_id = p_org
       and e.organization_id = p_org
       and p.user_id = m.user_id
       -- ponytail: casa pelo começo; duas consultas da mesma pessoa no mesmo
       -- começo viram uma linha na foto (a importação já junta as iguais).
       and e.starts_at = m.starts_at
    returning 1
  )
  select count(*)::integer from apagados;
$$;

-- Função nova em `public` nasce EXPOSTA — as DUAS origens de EXECUTE (CLAUDE.md).
revoke execute on function public.fn_agenda_clinicorp_conciliar(uuid) from public, anon, authenticated;
grant execute on function public.fn_agenda_clinicorp_conciliar(uuid) to service_role;

notify pgrst, 'reload schema';
