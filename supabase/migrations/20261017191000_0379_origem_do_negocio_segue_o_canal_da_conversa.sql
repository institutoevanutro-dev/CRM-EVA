-- Migration 0379 : O NEGÓCIO DIZ POR ONDE O CLIENTE CHEGOU — INSTAGRAM NÃO VIRA WHATSAPP.
--
-- Portado do projeto original (DeskcommCRM, PR #2199 de @paulolimajr77; lá é a
-- migration 0531).
--
-- O DEFEITO: `garantirLeadDaConversa` (`lib/leads/nascimento-do-lead.ts`) já
-- lia o canal da conversa para o título e para a linha do tempo ("Entrou pelo
-- Instagram"), mas gravava `crm_leads.source = 'whatsapp'` em todo negócio que
-- não fosse de anúncio nem de campanha. O negócio aberto por uma mensagem no
-- direct do Instagram constava como vindo do WhatsApp, e todo relatório por
-- origem o contava no lugar errado. O código passa a gravar o canal
-- (`sourceDoCanal`); esta migration corrige os negócios que JÁ nasceram errados.
--
-- Facebook: neste fork `conversations.channel` só aceita 'whatsapp' e
-- 'instagram' (CHECK `conversations_channel_check`, migration 0277) — não existe
-- conversa de Facebook para corrigir. O critério abaixo já a cobre se um dia
-- existir.
--
-- O CRITÉRIO É A ATIVIDADE, E NÃO O CONTATO: o vínculo exato entre o negócio e
-- a conversa que o fez nascer só existe na atividade `lead_created` gravada por
-- `garantirLeadDaConversa` (`source_module = 'canal.ingest'`, `source_id` =
-- conversa). Um contato pode ter conversas em mais de um canal; casar pelo
-- contato poderia trocar a origem de um negócio que nasceu, de fato, no
-- WhatsApp.
--
-- O QUE NÃO SE TOCA (conservador de propósito):
--   - qualquer `source` que não seja EXATAMENTE 'whatsapp' (o valor que o
--     código gravava): 'Whatsapp', 'whatsapp_operador', 'Instagram', 'meta_ads',
--     'importacao_planilha', 'import_csv', 'manual', 'Link', 'Indicação'... —
--     origem digitada, importada ou de anúncio fica como está;
--   - negócio sem a atividade `lead_created` de `canal.ingest` (criado à mão,
--     importado, clonado de outro funil);
--   - a linha do tempo: a atividade antiga segue com o que gravou;
--   - nenhum evento é emitido (`fn_emit_event_on_lead_change` só reage a status
--     e dono). O `updated_at` do negócio corrigido avança — é o rastro.
--
-- Genérica para qualquer banco (nenhum id fixo) e idempotente: a segunda
-- aplicação não acha mais `source = 'whatsapp'` nesses negócios. A rota de
-- edição do negócio não aceita `source` (`updateLeadSchema`), então reaplicar a
-- cada update.sh não desfaz escolha de ninguém.
-- No baseline, bloco no fim do apêndice (não cria função).
-- Prova: tests/invariants/origem-do-negocio-segue-o-canal-da-conversa.test.ts.

update public.crm_leads l
   set source = c.channel
  from public.crm_lead_activities a
  join public.conversations c
    on c.organization_id = a.organization_id
   and c.id = a.source_id
 where a.organization_id = l.organization_id
   and a.lead_id = l.id
   and a.type = 'lead_created'
   and a.source_module = 'canal.ingest'
   and c.channel in ('instagram', 'facebook')
   and l.source = 'whatsapp';
