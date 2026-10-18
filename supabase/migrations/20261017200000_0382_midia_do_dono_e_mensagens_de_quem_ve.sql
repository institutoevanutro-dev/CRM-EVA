-- ============================================================================
-- 0382 — LINK DE MÍDIA SÓ DO PRÓPRIO DONO; MENSAGEM SÓ DE QUEM VÊ A CONVERSA
-- (auditoria de segurança de 17/10/2026, achados CRM-1 e CRM-2)
--
-- ─── CRM-1: caminho gravável pela sessão, assinado pela service role
--
-- `messages.media_storage_path` e `contacts.avatar_storage_path` eram texto
-- livre para a sessão (GRANT da tabela + policies que só olham a organização).
-- As rotas de mídia e de foto leem o caminho com a sessão e o assinam com a
-- service role, que não conhece organização: um caminho de outra conversa, ou
-- de outra organização, gravado numa linha própria virava link assinado.
--
-- As rotas passam a conferir o caminho antes de assinar (o conserto principal,
-- em TypeScript, que vale também para linha antiga). Aqui fica a segunda
-- camada, no banco, para todo leitor que assina sem conferir:
--
--   messages  na escrita com sessão, caminho novo é `{org}/{conversa}/{arquivo}`
--             da PRÓPRIA linha, a regra de `isMediaPathOwnedBy`
--             (lib/messaging/media/upload-validation.ts) que a rota de envio já
--             aplica; 42501 `midia_da_mensagem_fora_da_conversa`.
--   contacts  a sessão não grava foto: quem grava é o cron contact-avatars
--             (service role). Zerar continua livre (anonimização).
--             42501 `foto_do_contato_so_o_servidor`.
--
-- Por que gatilho e não grant de coluna: a sessão INSERE `media_storage_path`
-- legitimamente (envio de mídia pelo cliente de sessão, app/api/v1/messages/
-- _handler.ts), então revogar a coluna quebraria o envio. Mesmo molde da
-- `fn_nota_interna_autoria_e_do_banco` e da `fn_bloqueio_do_contato_so_o_servidor`
-- (0319): service role, motor e migrations passam.
--
-- ─── CRM-2: apagar e reescrever mensagem de conversa que não se vê
--
-- `messages_update` e `messages_delete` só exigiam a organização (e, pela
-- restritiva da 0299, papel `agent`). Um atendente que não vê a conversa (modo
-- de visibilidade "só as suas") apagava ou reescrevia as mensagens dela pelo
-- PostgREST, sem auditoria. Agora:
--
--   UPDATE  só em mensagem de conversa que a sessão vê
--           (`fn_can_view_conversation`), na leitura e na escrita;
--   DELETE  idem, e só o eco do próprio envio (`sent_via = 'external_device'`),
--           que é o único DELETE de mensagem com sessão no produto
--           (`removerEcoDoProprioEnvio`, app/api/v1/messages/_handler.ts).
--           Apagar a conversa (gestor, 0319) leva as mensagens pela cascata de
--           FK, que não passa por estas policies.
--
-- Leitura, envio, Realtime, notas e as edições/"apagar para todos" (que chegam
-- pelo webhook, com service role) não mudam.
--
-- Provas: tests/invariants/mensagem-so-de-quem-ve-a-conversa.test.ts e
-- tests/invariants/caminho-de-midia-gravado-pela-sessao.test.ts.
-- Idempotente; sem BEGIN/COMMIT.
-- ============================================================================

-- ─── CRM-2 ──────────────────────────────────────────────────────────────────
drop policy if exists "messages_update" on public.messages;
create policy "messages_update" on public.messages
  for update using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and exists (
          select 1 from public.conversations c
           where c.id = messages.conversation_id
             and c.organization_id = messages.organization_id
             and public.fn_can_view_conversation(c.organization_id, c.assigned_to_user_id)
        ))
  ) with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and exists (
          select 1 from public.conversations c
           where c.id = messages.conversation_id
             and c.organization_id = messages.organization_id
             and public.fn_can_view_conversation(c.organization_id, c.assigned_to_user_id)
        ))
  );

drop policy if exists "messages_delete" on public.messages;
create policy "messages_delete" on public.messages
  for delete using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and sent_via = 'external_device'
        and exists (
          select 1 from public.conversations c
           where c.id = messages.conversation_id
             and c.organization_id = messages.organization_id
             and public.fn_can_view_conversation(c.organization_id, c.assigned_to_user_id)
        ))
  );

-- ─── CRM-1 ──────────────────────────────────────────────────────────────────
create or replace function public.fn_midia_da_mensagem_e_da_conversa()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_prefixo text := new.organization_id::text || '/' || new.conversation_id::text || '/';
  v_arquivo text := substr(new.media_storage_path, length(v_prefixo) + 1);
begin
  if auth.uid() is null and current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if left(new.media_storage_path, length(v_prefixo)) is distinct from v_prefixo
     or v_arquivo !~ '^[A-Za-z0-9._-]+$'
     or v_arquivo in ('.', '..') then
    raise exception 'midia_da_mensagem_fora_da_conversa' using errcode = '42501';
  end if;
  return new;
end $$;

comment on function public.fn_midia_da_mensagem_e_da_conversa() is
  'Guarda de messages (migration 0382): na escrita com sessão, media_storage_path novo é {org}/{conversa}/{arquivo} '
  'da própria linha (regra de isMediaPathOwnedBy); 42501 midia_da_mensagem_fora_da_conversa. Service role, motor e '
  'migrations passam. Provado em tests/invariants/caminho-de-midia-gravado-pela-sessao.test.ts.';

revoke execute on function public.fn_midia_da_mensagem_e_da_conversa() from public, anon, authenticated;

create or replace trigger trg_midia_da_mensagem_e_da_conversa_insert
  before insert on public.messages
  for each row
  when (new.media_storage_path is not null)
  execute function public.fn_midia_da_mensagem_e_da_conversa();

create or replace trigger trg_midia_da_mensagem_e_da_conversa_update
  before update on public.messages
  for each row
  when (new.media_storage_path is not null
        and (old.media_storage_path is distinct from new.media_storage_path
             or old.conversation_id is distinct from new.conversation_id
             or old.organization_id is distinct from new.organization_id))
  execute function public.fn_midia_da_mensagem_e_da_conversa();

create or replace function public.fn_foto_do_contato_so_o_servidor()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.uid() is not null or current_user in ('authenticated', 'anon') then
    raise exception 'foto_do_contato_so_o_servidor' using errcode = '42501';
  end if;
  return new;
end $$;

comment on function public.fn_foto_do_contato_so_o_servidor() is
  'Guarda de contacts (migration 0382): sessão nenhuma grava avatar_storage_path não nulo (42501 '
  'foto_do_contato_so_o_servidor); quem grava é o cron contact-avatars, com service role. Zerar é livre. '
  'Provado em tests/invariants/caminho-de-midia-gravado-pela-sessao.test.ts.';

revoke execute on function public.fn_foto_do_contato_so_o_servidor() from public, anon, authenticated;

create or replace trigger trg_foto_do_contato_so_o_servidor_insert
  before insert on public.contacts
  for each row
  when (new.avatar_storage_path is not null)
  execute function public.fn_foto_do_contato_so_o_servidor();

create or replace trigger trg_foto_do_contato_so_o_servidor_update
  before update on public.contacts
  for each row
  when (new.avatar_storage_path is not null
        and (old.avatar_storage_path is distinct from new.avatar_storage_path
             or old.organization_id is distinct from new.organization_id
             or old.id is distinct from new.id))
  execute function public.fn_foto_do_contato_so_o_servidor();
