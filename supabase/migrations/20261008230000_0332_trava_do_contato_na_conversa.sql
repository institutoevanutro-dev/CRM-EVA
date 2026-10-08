-- 0332 — "Quem manda na conversa" sem consultar o contato: a trava fica na própria conversa.
--
-- Depois da 0331, cada contagem por `comando_da_conversa` ainda chamava uma função
-- por conversa para ler `contacts`. Medido em produção na 3.10.0 (08/10/2026): 0,55 s
-- sozinha, ~3 s sob a carga do Inbox (6 contagens em paralelo, edge logs do Supabase).
--
-- Agora `conversations.contato_segura_robo` guarda `force_human or is_blocked` do
-- contato, mantido por gatilho dos DOIS lados:
--  - em `contacts`, quando `force_human` ou `is_blocked` mudam, as conversas do
--    contato são atualizadas;
--  - em `conversations`, ao inserir ou trocar `contact_id`, o valor é lido do contato.
-- Com isso `comando_da_conversa(c)` deixa de consultar outra tabela e o planejador
-- pode inline-la. A regra `fn_comando_da_conversa` não muda.
--
-- As funções de gatilho são `security definer`: precisam ler/escrever as linhas do
-- contato e das conversas dele independentemente da RLS de quem fez a mudança, e
-- não são expostas (revogadas de todos os papéis do PostgREST).

alter table public.conversations
  add column if not exists contato_segura_robo boolean not null default false;

-- Backfill: só as linhas que divergem (idempotente e barato na reaplicação).
update public.conversations c
   set contato_segura_robo = (ct.force_human is true or ct.is_blocked is true)
  from public.contacts ct
 where ct.id = c.contact_id
   and c.contato_segura_robo is distinct from (ct.force_human is true or ct.is_blocked is true);

create or replace function public.fn_conversa_herda_trava_do_contato()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.contact_id is null then
    new.contato_segura_robo := false;
  else
    select coalesce(ct.force_human is true or ct.is_blocked is true, false)
      into new.contato_segura_robo
      from public.contacts ct where ct.id = new.contact_id;
    new.contato_segura_robo := coalesce(new.contato_segura_robo, false);
  end if;
  return new;
end;
$fn$;
revoke all on function public.fn_conversa_herda_trava_do_contato() from public, anon, authenticated;

drop trigger if exists trg_conversa_herda_trava_do_contato on public.conversations;
create trigger trg_conversa_herda_trava_do_contato
  before insert or update of contact_id on public.conversations
  for each row execute function public.fn_conversa_herda_trava_do_contato();

create or replace function public.fn_contato_propaga_trava()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update public.conversations
     set contato_segura_robo = (new.force_human is true or new.is_blocked is true)
   where contact_id = new.id
     and contato_segura_robo is distinct from (new.force_human is true or new.is_blocked is true);
  return new;
end;
$fn$;
revoke all on function public.fn_contato_propaga_trava() from public, anon, authenticated;

drop trigger if exists trg_contato_propaga_trava on public.contacts;
create trigger trg_contato_propaga_trava
  after update of force_human, is_blocked on public.contacts
  for each row
  when (old.force_human is distinct from new.force_human or old.is_blocked is distinct from new.is_blocked)
  execute function public.fn_contato_propaga_trava();

create or replace function public.comando_da_conversa(c public.conversations)
returns text
language sql
stable
set search_path = public
as $comando$
  select public.fn_comando_da_conversa(
    c.status,
    c.assigned_to_user_id,
    c.bot_silenced_until,
    c.contato_segura_robo,
    false,
    now()
  );
$comando$;

revoke execute on function public.comando_da_conversa(public.conversations) from public, anon;
grant  execute on function public.comando_da_conversa(public.conversations) to authenticated, service_role;
