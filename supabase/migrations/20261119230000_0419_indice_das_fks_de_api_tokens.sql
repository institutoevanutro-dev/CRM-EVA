-- 0419: índice nas duas FKs que apontam para api_tokens.
--
-- Por quê: api_audit_log.actor_api_token_id e
-- prontuario_contact_links.linked_by_api_token_id são `on delete set null`
-- e não tinham índice. Apagar UMA chave fazia o Postgres varrer a auditoria
-- inteira (~130 mil linhas) atrás de referências. A poda das chaves
-- temporárias de IA (5.26.2, lib/ai/runtime/mcp_token.ts) apaga milhares de
-- uma vez e estourava o statement_timeout de 8s do PostgREST sem apagar nada
-- — então elas continuavam acumulando (~5 mil numa instalação real) e a tela
-- Configurações › Chaves de integração ficava em "Carregando…".
--
-- Só cria índice: nenhum dado muda. Idempotente.
create index if not exists api_audit_log_actor_api_token_id_idx
  on public.api_audit_log (actor_api_token_id)
  where actor_api_token_id is not null;

create index if not exists prontuario_contact_links_linked_by_api_token_id_idx
  on public.prontuario_contact_links (linked_by_api_token_id)
  where linked_by_api_token_id is not null;
