-- ============================================================================
-- 0372 — OCULTAR UM CONTATO DO INBOX
--
-- ─── O problema
--
-- Um dos Instagram conectados é o perfil PESSOAL do médico: as mensagens dos
-- amigos dele caem no Inbox da clínica, contam na Fila, nos não lidos, no radar
-- e nos números do Início, e entram nas mesmas regras de IA, follow-up e
-- funil que um paciente. Não há como dizer "isto não é da clínica".
--
-- ─── A regra
--
-- `contacts.inbox_hidden_at` (+ `inbox_hidden_by`) marca o contato como oculto
-- do Inbox. As mensagens CONTINUAM sendo gravadas (nada se perde, a LGPD não
-- muda); o que muda é quem enxerga e quem age:
--
--   - Inbox (listas, contagens, não lidos, Fila), radar, Início e o painel de
--     conversas por dia deixam de contar as conversas desse contato;
--   - a IA não responde, follow-up e automação não mandam mensagem, e o
--     contato não ganha negócio novo no funil (TypeScript, na mesma entrega);
--   - gerente e administrador veem os ocultos na aba "Ocultos" do Inbox e
--     podem trazê-los de volta.
--
-- ─── O predicado mora NA CONVERSA
--
-- O Inbox lista e conta `conversations`, e o filtro precisa caber na MESMA
-- consulta para o cursor de paginação e os contadores continuarem valendo
-- (filtrar em memória quebraria os dois). Por isso `conversations.contato_oculto`
-- guarda `inbox_hidden_at is not null` do contato, mantido por gatilho dos DOIS
-- lados, molde exato da 0332 (`contato_segura_robo`):
--   - em `contacts`, quando `inbox_hidden_at` muda, as conversas do contato
--     são atualizadas;
--   - em `conversations`, ao inserir ou trocar `contact_id` (junção de
--     contatos), o valor é lido do contato.
-- A fonte da verdade é o CONTATO; a coluna da conversa é cópia derivada, que só
-- os gatilhos escrevem.
--
-- ─── Só o servidor marca
--
-- `contacts_update` deixa o atendente editar a ficha pela sessão, e nada
-- separaria a marca dos outros campos: um atendente traria de volta pelo
-- PostgREST, sem papel de gerente e sem linha na auditoria. O gatilho
-- `trg_ocultacao_do_contato_so_o_servidor` recusa (42501) a escrita dessas duas
-- colunas vinda da sessão; o único escritor é a rota
-- (`app/api/v1/contacts/[id]/ocultar`, chave de serviço, auditada). Mesmo
-- desenho de `fn_bloqueio_do_contato_so_o_servidor`.
--
-- ─── O painel de conversas por dia
--
-- `fn_inicio_conversas_por_dia` (0330) passa a ignorar conversa de contato
-- oculto. A função lê a coluna nova, e `language sql` confere o corpo ao ser
-- criada: no baseline a coluna também é acrescentada no bloco da 0330, antes da
-- função, para a instalação nova não tropeçar na ordem.
--
-- Idempotente: `add column if not exists`, `create or replace`, e o backfill só
-- toca linha que diverge. Vigiado por tests/invariants/ocultar-contato-do-inbox.test.ts.
-- ============================================================================

alter table public.contacts
  add column if not exists inbox_hidden_at timestamptz,
  add column if not exists inbox_hidden_by uuid references auth.users(id) on delete set null;

comment on column public.contacts.inbox_hidden_at is
  'Oculto do Inbox (migration 0372): as conversas saem do Inbox, do radar e do Início; a IA não responde, follow-up e automação não mandam mensagem e o contato não ganha negócio novo. As mensagens continuam sendo gravadas. Só o servidor escreve (trg_ocultacao_do_contato_so_o_servidor).';
comment on column public.contacts.inbox_hidden_by is
  'Quem ocultou o contato do Inbox (migration 0372). NULL quando visível.';

-- `authenticated` lê contacts por grant de COLUNA (0289: tudo menos cpf_hash), e
-- coluna nova não entra sozinha nesse grant.
grant select (inbox_hidden_at, inbox_hidden_by) on public.contacts to authenticated;

alter table public.conversations
  add column if not exists contato_oculto boolean not null default false;

comment on column public.conversations.contato_oculto is
  'Cópia de contacts.inbox_hidden_at is not null (migration 0372), mantida pelos gatilhos trg_contato_propaga_ocultacao e trg_conversa_herda_ocultacao_do_contato. É o predicado único do Inbox: listas, contagens e Fila pedem contato_oculto = false.';

-- A aba "Ocultos" lê poucas linhas de muitas: o índice parcial a serve sem
-- pesar na escrita das conversas comuns.
create index if not exists idx_conversations_org_contato_oculto
  on public.conversations (organization_id, last_message_at desc)
  where contato_oculto;

-- Backfill: só as linhas que divergem (idempotente e barato na reaplicação).
update public.conversations c
   set contato_oculto = (ct.inbox_hidden_at is not null)
  from public.contacts ct
 where ct.id = c.contact_id
   and c.contato_oculto is distinct from (ct.inbox_hidden_at is not null);

create or replace function public.fn_conversa_herda_ocultacao_do_contato()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.contact_id is null then
    new.contato_oculto := false;
  else
    select ct.inbox_hidden_at is not null
      into new.contato_oculto
      from public.contacts ct where ct.id = new.contact_id;
    new.contato_oculto := coalesce(new.contato_oculto, false);
  end if;
  return new;
end;
$fn$;

create or replace trigger trg_conversa_herda_ocultacao_do_contato
  before insert or update of contact_id on public.conversations
  for each row execute function public.fn_conversa_herda_ocultacao_do_contato();

create or replace function public.fn_contato_propaga_ocultacao()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update public.conversations
     set contato_oculto = (new.inbox_hidden_at is not null)
   where contact_id = new.id
     and contato_oculto is distinct from (new.inbox_hidden_at is not null);
  return new;
end;
$fn$;

create or replace trigger trg_contato_propaga_ocultacao
  after update of inbox_hidden_at on public.contacts
  for each row
  when (old.inbox_hidden_at is distinct from new.inbox_hidden_at)
  execute function public.fn_contato_propaga_ocultacao();

-- Quem é barrado é a SESSÃO, pelos dois sinais de `fn_bloqueio_do_contato_so_o_servidor`:
-- `auth.uid()` preenchido ou o papel `authenticated`/`anon`. A chave de serviço,
-- o `pg.Pool` do motor e as migrations passam. Erro 42501 com o nome da regra, e
-- não "zero linhas": o PostgREST devolveria sucesso num UPDATE que não pegou.
create or replace function public.fn_ocultacao_do_contato_so_o_servidor()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if tg_op = 'INSERT' then
    if new.inbox_hidden_at is null and new.inbox_hidden_by is null then
      return new;
    end if;
  elsif new.inbox_hidden_at is not distinct from old.inbox_hidden_at
    and new.inbox_hidden_by is not distinct from old.inbox_hidden_by then
    return new;
  end if;
  if auth.uid() is not null or current_user in ('authenticated', 'anon') then
    raise exception 'ocultacao_do_contato_so_o_servidor' using errcode = '42501';
  end if;
  return new;
end;
$fn$;

create or replace trigger trg_ocultacao_do_contato_so_o_servidor
  before insert or update of inbox_hidden_at, inbox_hidden_by on public.contacts
  for each row execute function public.fn_ocultacao_do_contato_so_o_servidor();

-- As três são de gatilho: ninguém as chama pela REST. As DUAS origens de EXECUTE
-- saem (CLAUDE.md, item 9), e `authenticated` também.
do $janela$ begin
  revoke all on function public.fn_conversa_herda_ocultacao_do_contato() from public, anon, authenticated;
  revoke all on function public.fn_contato_propaga_ocultacao() from public, anon, authenticated;
  revoke all on function public.fn_ocultacao_do_contato_so_o_servidor() from public, anon, authenticated;
end $janela$;

-- O painel de conversas por dia do Início (0330) deixa de contar conversa de
-- contato oculto. Corpo idêntico ao da 0330, com `and not c.contato_oculto`.
create or replace function public.fn_inicio_conversas_por_dia(p_org uuid, p_inicio timestamptz, p_fim timestamptz, p_fuso text)
returns table(dia date, ia_sozinha int, com_equipe int, sem_resposta int, soma_primeira_resposta_s float8, respondidas int)
language sql stable
set search_path = public
as $$
  with conv as (
    select c.id, (c.created_at at time zone p_fuso)::date as dia
      from public.conversations c
     where c.organization_id = p_org and not c.is_group and not c.contato_oculto
       and c.created_at >= p_inicio and c.created_at < p_fim
  ), msg as (
    -- sent_via='ai' cobre QUALQUER ator não humano (lembrete, campanha, automação);
    -- fala da IA é a marca de autoria, a mesma régua de ehFalaDaIa
    -- (lib/ai/handoff/aviso-ao-lead.ts). Envio que falhou não é resposta.
    select m.conversation_id, m.direction, m.sent_at,
           (m.direction = 'outbound' and m.status <> 'failed'
             and coalesce(m.metadata->>'aviso_de_escalacao', '') <> 'true'
             and (jsonb_typeof(m.metadata->'ai_actor_id') = 'string'
                  or m.metadata->>'ai_generated' = 'true'
                  or m.metadata->>'texto_escrito_pela_ia' = 'true')) as da_ia,
           (m.direction = 'outbound' and m.status <> 'failed'
             and (m.sent_by_user_id is not null or m.sent_via in ('user', 'external_device'))) as da_equipe
      from public.messages m
      join conv on conv.id = m.conversation_id
     where m.organization_id = p_org
  ), por_conv as (
    select conv.id, conv.dia,
           coalesce(bool_or(m.da_ia), false) as ia,
           coalesce(bool_or(m.da_equipe), false) as humano,
           min(m.sent_at) filter (where m.direction = 'inbound') as pri_in
      from conv
      left join msg m on m.conversation_id = conv.id
     group by conv.id, conv.dia
  ), com_resposta as (
    select p.*,
           (select min(m.sent_at) from msg m
             where m.conversation_id = p.id and (m.da_ia or m.da_equipe)
               and m.sent_at > p.pri_in) as pri_out
      from por_conv p
  )
  select p.dia,
         (count(*) filter (where p.ia and not p.humano))::int,
         (count(*) filter (where p.humano))::int,
         (count(*) filter (where not p.ia and not p.humano))::int,
         coalesce(sum(extract(epoch from p.pri_out - p.pri_in)) filter (where p.pri_out > p.pri_in), 0)::float8,
         (count(*) filter (where p.pri_out > p.pri_in))::int
    from com_resposta p
   group by p.dia
   order by p.dia;
$$;

notify pgrst, 'reload schema';
