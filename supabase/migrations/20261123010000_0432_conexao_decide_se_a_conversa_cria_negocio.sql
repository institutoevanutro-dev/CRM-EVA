-- 0432: a CONEXÃO decide se a conversa nova cria negócio no funil (porte do upstream #4683,
-- issue #4670 de lá, migration 9459 de lá).
--
-- Uma empresa com vários números usa só alguns para vender, e os outros (suporte, pós-venda,
-- o celular de um vendedor) enchem o funil de cards que alguém precisa perder à mão.
--
-- ⚠️ `default true` NÃO É DETALHE: é o que faz a atualização ser invisível. Toda linha
-- existente nasce ligada (no Postgres 11+ um default não-volátil não reescreve a tabela), e a
-- instalação que nunca abrir a tela continua criando card em todo número, como antes.
--
-- Por que COLUNA e não `metadata`: a chave é lida no caminho quente da ingestão, uma vez por
-- card que nasce, e a ausência de chave em jsonb teria de significar LIGADO. Coluna booleana
-- com default diz isso sem depender de nenhum leitor lembrar da regra.
--
-- Sem função nova e sem RLS nova: a coluna anda com as policies de `channel_sessions`, e a
-- escrita auditada sai da rota de admin com o cliente de serviço.

alter table public.channel_sessions
  add column if not exists conversa_nova_cria_negocio boolean not null default true;

comment on column public.channel_sessions.conversa_nova_cria_negocio is
  'Migration 0432: a conversa nova que chega por esta conexão abre negócio no funil? true (DEFAULT, e o estado de toda instalação de antes) = sim, como sempre foi. false = a conversa e o contato nascem, o Inbox e a IA seguem, e só o card não nasce; criar à mão (crm_create_lead, painel da conversa, ficha do contato) continua igual.';
