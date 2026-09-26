-- O envio pelo Instagram endereça o CLIENTE pelo IGSID, que é por perfil
-- conectado. Guardá-lo na conversa (e não só na identidade do contato) mantém
-- o destinatário certo quando um contato tiver conversas em dois perfis.
-- Backfill idempotente: só preenche onde está vazio e a identidade é única.
update public.conversations c
   set provider_conversation_id = i.external_id
  from public.contact_channel_identities i
 where c.channel = 'instagram'
   and c.provider_conversation_id is null
   and i.organization_id = c.organization_id
   and i.contact_id = c.contact_id
   and i.channel = 'instagram'
   and (select count(*) from public.contact_channel_identities i2
         where i2.organization_id = c.organization_id and i2.contact_id = c.contact_id and i2.channel = 'instagram') = 1;

-- Só a equipe responde no Instagram (a IA nunca). Conversa sem dono e sem
-- silêncio é classificada `automatico` por fn_comando_da_conversa e some na
-- aba "Automático", onde ninguém olha. Silêncio durável ('infinity', o mesmo
-- literal do handoff e do pause-ai) a põe em `aguardando`, na Fila. A ingestão
-- grava o mesmo a cada mensagem; isto cura as conversas que já existem.
-- Idempotente: só toca quem ainda não está calado para sempre.
update public.conversations
   set bot_silenced_until = 'infinity'
 where channel = 'instagram'
   and (bot_silenced_until is null or bot_silenced_until < 'infinity'::timestamptz);
