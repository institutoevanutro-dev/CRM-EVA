-- 0282 — a organização que a pessoa usou por último, para o CRM abrir nela.
--
-- O PROBLEMA, medido numa instalação real: quem pertence a duas organizações
-- escolhia uma pelo seletor, o cookie `active_org` guardava por 30 dias — e o
-- logout apagava o cookie (`app/actions/auth/signOut.ts`, de propósito: cookie
-- de organização não pode sobreviver à sessão de quem sai). Na volta,
-- `loadAuthUser` caía na ordenação de desempate (`accepted_at ASC`) e reabria na
-- organização aceita PRIMEIRO. No caso medido, duas horas de diferença no
-- aceite, em 13/09/2026, decidiam a tela de abertura de todo dia desde então.
--
-- POR QUE COLUNA E NÃO `interface_settings` (jsonb, que já existe na tabela):
-- o anti-pattern 6 do CLAUDE.md é `jsonb` lock-in, e este dado é do vínculo,
-- tem tipo próprio e é LIDO EM ORDER BY a cada carga de página. Ordenar por
-- `->>` compara texto e perde o índice.
--
-- POR QUE UM TIMESTAMP E NÃO UM BOOLEANO `é_a_padrão`: booleano por linha
-- precisa que marcar uma DESMARQUE as outras — duas linhas `true` é um estado
-- que o schema não impede e que ninguém conserta depois. "A mais recente vence"
-- não tem estado inválido: escrever numa linha não estraga as outras.
--
-- NULL = nunca trocou de organização pelo seletor. Não é defeito: é o estado de
-- toda instalação existente no dia desta migration, e de toda pessoa com uma
-- organização só. Quem é NULL cai no desempate de sempre.
alter table public.user_organizations
  add column if not exists ultima_ativacao_em timestamptz;

comment on column public.user_organizations.ultima_ativacao_em is
  'Quando a pessoa ativou esta organização pelo seletor. Decide em qual o CRM abre quando não há cookie active_org (o logout o apaga). NULL = nunca trocou.';

-- Índice pelo par que a consulta de `loadAuthUser` usa: ela filtra por
-- `user_id` e ordena por esta coluna. Sem ele, quem tem várias organizações
-- paga um sort a cada carga de página autenticada.
create index if not exists user_organizations_ultima_ativacao_idx
  on public.user_organizations (user_id, ultima_ativacao_em desc nulls last);
