-- Migration 0407 : EXTRAÇÃO SILENCIOSA DE CADASTRO — a fila de proposta aceita CPF e endereço.
--
-- Quando a equipe atende pelo celular, a conversa fica silenciada para a IA e o
-- CPF, o e-mail, a data de nascimento e o endereço que o paciente manda depois
-- que a equipe pede não eram lidos por ninguém. A extração silenciosa
-- (`lib/contacts/extracao-silenciosa.ts`, ligada por organização em
-- `organizations.settings.crm.extracao_silenciosa`, desligada por padrão) só
-- PREENCHE campo vazio; valor diferente do gravado vira PROPOSTA nesta fila e
-- aviso na Central. Três mudanças, todas só de crescimento:
--
-- 1. `contact_field_proposals.campo` ganha `cpf` e `endereco` (drop + add, mesmo
--    molde da 0334). Endereço é o MESMO lugar que a ficha edita e o Prontuário
--    lê: `contacts.custom_fields.endereco` (texto livre).
--
-- 2. `contact_field_proposals.valor_cifrado bytea` — o CPF proposto, cifrado
--    pela MESMA `encrypt_cpf` que cifra `contacts.cpf_encrypted`. O resto do
--    sistema só guarda CPF cifrado, e esta tabela não pode ser a exceção. A
--    constraint `contact_field_proposals_cpf_cifrado` põe isso no schema:
--    proposta de CPF exige a cifra, não guarda valor anterior, e o
--    `valor_proposto` (o que a tela mostra) tem no máximo 2 dígitos — a máscara
--    `•••.•••.•••-NN`. Qualquer outro campo tem `valor_cifrado` nulo.
--
-- 3. `agent_inbox_items.kind` ganha `contact_data_divergent`: o paciente
--    informou um dado diferente do cadastro e há uma sugestão esperando alguém
--    na ficha. Kind próprio porque `contact_proposal_expired` diz que a
--    sugestão VENCEU, e `other` não aponta para o contato.
--
-- Nenhuma linha existente viola as constraints novas (nenhuma proposta usa os
-- vocábulos novos, `valor_cifrado` nasce nulo). Idempotente: `drop constraint
-- if exists` antes de cada `add`, `add column if not exists`. Nenhuma função
-- nova. No `baseline.sql`: o vocábulo entra no bloco ÚNICO de cada constraint
-- (`baseline-constraint-reconstruida.test.ts`); a coluna e a constraint nova
-- entram no apêndice, bloco da 0407.

alter table public.contact_field_proposals
  drop constraint if exists contact_field_proposals_campo_check;
alter table public.contact_field_proposals
  add constraint contact_field_proposals_campo_check check (
    campo = any (array['email', 'name', 'phone_number', 'birthdate', 'cpf', 'endereco']::text[])
  );

alter table public.contact_field_proposals
  add column if not exists valor_cifrado bytea;

comment on column public.contact_field_proposals.valor_cifrado is
  'CPF proposto, cifrado por encrypt_cpf (o mesmo par de contacts.cpf_encrypted). Só em campo = ''cpf''; valor_proposto guarda a máscara.';

alter table public.contact_field_proposals
  drop constraint if exists contact_field_proposals_cpf_cifrado;
alter table public.contact_field_proposals
  add constraint contact_field_proposals_cpf_cifrado check (
    case when campo = 'cpf'
      then valor_cifrado is not null
           and valor_anterior is null
           and length(regexp_replace(valor_proposto, '[^0-9]', '', 'g')) <= 2
      else valor_cifrado is null
    end
  );

alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'appointment_outcome_required',
    'appointment_recovery_review',
    'qr_rescan',
    'routing_unassigned',
    'job_dead',
    'event_dead',
    'budget_exceeded',
    'handoff',
    'promotion_review',
    'judge_unaligned',
    'followup_dead',
    'snooze_expired',
    'next_action_ambiguous',
    'risk_backlog_seeded',
    'reactivation_expired',
    'capabilities_missing',
    'message_send_stuck',
    'midia_nao_lida',
    'channel_template_review',
    'channel_number_alert',
    'promise_unfulfilled',
    'contact_proposal_expired',
    'budget_warning',
    'conhecimento_nao_indexado',
    'voice_call_missed',
    'case_stale',
    'supervision_review',
    'sinal_revisao_humana',
    'instagram_comment_stuck',
    'jev_pedido_de_humano',
    'jev_parar_de_receber',
    'ad_conversion_failing',
    'followup_notify_team',
    'contact_data_divergent',
    'other'
  ));
