-- Migration 0402 : EXAMES DO WHATSAPP NO PRONTUÁRIO — o registro do envio.
--
-- A recepção clica "Enviar ao prontuário" numa mensagem recebida com PDF ou
-- foto. O servidor do CRM chama o Prontuário, que busca o arquivo nas rotas
-- GET /api/v1/prontuario/... e devolve o exam_id. Esta tabela guarda o envio
-- confirmado (201/200), para o balão mostrar o selo "No prontuário".
--
-- Só service_role, como google_click_codes (0400): quem lê e grava é o
-- servidor, com organization_id da sessão. Sem FK para contacts: o contato sai
-- de messages.contact_id. ja_existia = o exame já estava no Prontuário (ex.: o
-- clínico trouxe antes); o selo diz isso em vez de atribuir o envio a quem clicou.
--
-- LGPD: exam_id leva ao paciente no Prontuário. Como na 0285, depois de
-- anonimizar o contato nenhum id externo pode reidentificar o registro: o
-- gatilho abaixo apaga as linhas das mensagens do contato. Na fusão não apaga
-- (o registro é por mensagem e a mensagem continua). A cópia do exame no
-- Prontuário segue a guarda do prontuário, fora desta cascata.
-- message_id on delete cascade: a linha é estado de tela derivado da mensagem.
-- Idempotente.
create table if not exists public.prontuario_exames_enviados (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  exam_id uuid not null,
  ja_existia boolean not null default false,
  enviado_por_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint prontuario_exames_enviados_pk primary key (organization_id, message_id)
);
alter table public.prontuario_exames_enviados add column if not exists ja_existia boolean not null default false;

alter table public.prontuario_exames_enviados enable row level security;
revoke all on public.prontuario_exames_enviados from anon, authenticated;
grant select, insert, update, delete on public.prontuario_exames_enviados to service_role;

comment on table public.prontuario_exames_enviados is
  'Envio de exame do WhatsApp ao Prontuário confirmado (201/200): mensagem → exam_id, ja_existia, quem e quando. Só service_role; apagado na anonimização do contato (migration 0402).';

create or replace function public.fn_apaga_exames_enviados_de_contato_anonimizado()
  returns trigger
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
begin
  delete from public.prontuario_exames_enviados e
   using public.messages m
   where e.organization_id = new.organization_id
     and m.id = e.message_id
     and m.organization_id = new.organization_id
     and (m.contact_id = new.id
          or m.conversation_id in (
            select c.id from public.conversations c
             where c.organization_id = new.organization_id and c.contact_id = new.id));
  return new;
end$$;

revoke all on function public.fn_apaga_exames_enviados_de_contato_anonimizado() from public;
revoke execute on function public.fn_apaga_exames_enviados_de_contato_anonimizado() from anon;
revoke execute on function public.fn_apaga_exames_enviados_de_contato_anonimizado() from authenticated;

create or replace trigger trg_contacts_anonimizado_limpa_exames_enviados
  after update of is_anonymized on public.contacts
  for each row
  when (new.is_anonymized = true and coalesce(old.is_anonymized, false) = false)
  execute function public.fn_apaga_exames_enviados_de_contato_anonimizado();
