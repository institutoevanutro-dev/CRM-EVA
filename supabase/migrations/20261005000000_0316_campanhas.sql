-- 0316 — CAMPANHAS (porte do DeskcommCRM original)
--
-- Porte das migrations 0374–0377 do melgarafael/DeskcommCRM (autor original:
-- lussandro.ilha; commit d571df589), juntadas num arquivo só porque neste fork a
-- numeração do original colide a partir da 0265. Os comentários abaixo citam os
-- números do original (0343/0344/0346/0374–0377): é a mesma coisa, numerada lá.
--
-- Acréscimo deste fork: a policy RESTRITIVA `mfa_provada` (migration 0301) nas
-- cinco tabelas novas, no fim do arquivo — `tests/invariants/mfa-na-rest.test.ts`
-- cobra toda tabela com `organization_id`.


-- ═════ do original: 0374_campanhas ═════

-- 0374 — CAMPANHAS (Sub-PRD 12 / Spec 12 / Spec 13)
--
-- ═══ O que nasce aqui, e o que deliberadamente NÃO nasce ═══
--
-- Duas tabelas: a campanha e o destinatário. Nenhuma tabela de proteção de envio,
-- nenhuma tabela de template, nenhuma suppression list.
--
--   * Proteção de envio (Spec 13 §4.1 pede `channel_send_protection`): já existe
--     neste repo e tem tela — `channel_knobs` (throttle, jitter, janela, domingo,
--     fuso, warm-up) mais `channel_sessions.daily_message_limit`, editados pela
--     `AntiBanSheet` (cujo título é, literalmente, "Proteção de envio"), e
--     respeitados por `decidePacing` com contador real em `pacing_ledger`. Criar a
--     tabela da spec daria à mesma instalação DUAS janelas e DOIS tetos por
--     conexão, e alguém teria de decidir qual ganha em cada caminho de envio — o
--     anti-pattern nº 2 do CLAUDE.md (duplicação sem source of truth). O que a
--     campanha ganha aqui é só o OVERRIDE dela, sempre mais restritivo que o canal.
--   * Templates internos e suppression list ficam fora do MVP por decisão do dono
--     do produto (2026-09-18). A coluna de conteúdo é uma só e é texto.
--   * `message_mode`/`provider_template_*` (Spec 12 §2.1) não entram: este fork
--     envia por WAHA, e coluna que ninguém escreve é promessa de recurso que não
--     existe. Quando o canal oficial entrar, entra com a migration dele.
--
-- ═══ Por que destinatário é LINHA e não lista em jsonb ═══
--
-- É ele que tem estado individual (pendente/enviado/pulado + motivo), unicidade
-- (ninguém recebe duas vezes) e contagem para o relatório. Em jsonb, cada envio
-- reescreveria o documento inteiro e duas rodadas concorrentes do cron perderiam
-- uma da outra.
--
-- ═══ Base legal não tem default ═══
--
-- Campanha sem base legal declarada não deve existir, e um default plausível aqui
-- seria exatamente o buraco que a Regra nº 1 proíbe: pareceria configurado e não
-- estaria. Interesse legítimo SEM a referência da LIA é o mesmo que nenhuma base
-- legal — é a referência que permite responder "com base em quê você me mandou
-- isto?" (vault: LIA-2026-01). O gate de LGPD da cadeia de envio
-- (`lib/agent-engine/guardrails/lgpd/legal-basis.ts`) usa a mesma régua.

create table if not exists public.campaigns (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  name text not null,
  description text,

  -- Os nove estados da Spec 12 §7.1. As transições válidas vivem em
  -- `lib/campanhas/maquina-de-estados.ts` — CHECK aqui guarda o VOCABULÁRIO, não a
  -- ordem: uma matriz de transição em SQL exigiria trigger, e trigger que decide
  -- fluxo é lógica de produto fora do lugar onde ela é testável.
  status text not null default 'draft',

  -- `on delete restrict`: apagar o número que uma campanha usou apagaria o
  -- histórico de para quem ela falou. Quem quiser sumir com o número arquiva a
  -- campanha antes.
  channel_session_id uuid not null,

  message_body text,

  base_legal text not null,
  lia_ref text,

  audience_filter jsonb not null default '{}'::jsonb,
  -- Sobe a cada preparação nova. O destinatário guarda a versão do CONTEÚDO com
  -- que foi congelado; a da audiência distingue snapshots entre si.
  audience_version integer not null default 1,
  content_version integer not null default 1,

  -- ═══ Ritmo PRÓPRIO da campanha (Spec 13 §4.2) ═══
  -- Todas nullable: null = herda do canal. O efetivo é sempre o MAIS RESTRITIVO
  -- entre campanha e canal — a campanha só sabe ir mais devagar, nunca mais
  -- rápido. Para lista FRIA o ritmo do canal não basta: 30 mensagens em 30 min do
  -- mesmo número, para quem nunca falou com a empresa, é o padrão que o WhatsApp
  -- bane, e número banido volta em semanas de warm-up, não em dias.
  intervalo_segundos integer,
  janela_inicio_hora smallint,
  janela_fim_hora smallint,
  teto_diario integer,
  teto_horario integer,

  scheduled_at timestamptz,
  prepared_at timestamptz,
  started_at timestamptz,
  paused_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  failed_at timestamptz,
  failure_code text,
  failure_detail text,

  snapshot_total integer not null default 0,
  snapshot_eligible integer not null default 0,
  snapshot_excluded integer not null default 0,

  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint campaigns_status_check check (status in (
    'draft','preparing','ready','scheduled','running',
    'paused','completed','cancelled','failed'
  )),
  constraint campaigns_name_check check (btrim(name) <> ''),
  constraint campaigns_base_legal_check check (base_legal in ('consent','legitimate_interest')),
  constraint campaigns_lia_exige_ref check (
    base_legal <> 'legitimate_interest' or coalesce(btrim(lia_ref), '') <> ''
  ),
  -- Faixas de sanidade do ritmo. Não são o default de comportamento (esse mora em
  -- `lib/agent-engine/pacing/defaults.ts`, fonte única dos números de pacing):
  -- são o que a coluna aceita de um operador.
  constraint campaigns_intervalo_check check (
    intervalo_segundos is null or intervalo_segundos between 1 and 86400
  ),
  constraint campaigns_janela_check check (
    (janela_inicio_hora is null and janela_fim_hora is null)
    or (janela_inicio_hora between 0 and 23
        and janela_fim_hora between 1 and 24
        and janela_fim_hora > janela_inicio_hora)
  ),
  constraint campaigns_teto_diario_check check (teto_diario is null or teto_diario between 1 and 10000),
  constraint campaigns_teto_horario_check check (teto_horario is null or teto_horario between 1 and 10000)
);

-- FK composta pela doutrina multi-tenant: uma campanha não pode apontar para o
-- número de OUTRA organização. Alvo é `uq_channel_sessions_org_id` (0262/0228).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'campaigns_channel_org_fk'
  ) then
    alter table public.campaigns
      add constraint campaigns_channel_org_fk
      foreign key (organization_id, channel_session_id)
      references public.channel_sessions (organization_id, id)
      on delete restrict;
  end if;
end $$;

comment on table public.campaigns is
  'Envio proativo a uma lista explícita de contatos, por um número. O ritmo próprio (intervalo/janela/tetos) é sempre mais restritivo que o do canal (channel_knobs + channel_sessions.daily_message_limit), nunca mais frouxo.';
comment on column public.campaigns.base_legal is
  'Base legal do tratamento (LGPD art. 7º). Sem default de propósito: campanha sem base legal declarada não deve existir. `legitimate_interest` exige `lia_ref` — a referência da avaliação de interesse legítimo que responde "com base em quê você me mandou isto?".';
comment on column public.campaigns.content_version is
  'Sobe quando o texto muda. O destinatário guarda a versão com que foi congelado, para edição futura não reescrever mensagem já preparada.';

create index if not exists idx_campaigns_org_status
  on public.campaigns (organization_id, status, created_at desc);

-- A pergunta do scheduler: quais campanhas agendadas já venceram.
create index if not exists idx_campaigns_agendadas
  on public.campaigns (scheduled_at)
  where status = 'scheduled';

create table if not exists public.campaign_recipients (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  -- Preenchida no envio, não no snapshot: a conversa pode nem existir quando a
  -- lista é montada.
  conversation_id uuid references public.conversations(id) on delete set null,

  -- O telefone CONGELADO no snapshot. O contato continua sendo a fonte da verdade
  -- do CRM, mas a campanha não recalcula retroativamente para quem ela ia falar.
  recipient_address text,

  status text not null default 'pending',
  eligibility_status text not null default 'eligible',
  -- Código, não frase: a frase legível mora no TypeScript e é traduzida.
  exclusion_reason text,

  variables jsonb not null default '{}'::jsonb,
  rendered_body text,
  content_version integer not null default 1,

  message_id uuid references public.messages(id) on delete set null,

  attempt_count integer not null default 0,
  next_attempt_at timestamptz,
  last_attempt_at timestamptz,
  last_error_code text,
  last_error_detail text,

  queued_at timestamptz,
  sending_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  replied_at timestamptz,
  opted_out_at timestamptz,
  cancelled_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint campaign_recipients_status_check check (status in (
    'pending','queued','sending','sent','delivered','read','replied',
    'failed','skipped','cancelled','opted_out'
  )),
  constraint campaign_recipients_eligibility_check check (
    eligibility_status in ('eligible','excluded')
  ),
  -- Ninguém recebe duas vezes: nem pelo mesmo cadastro, nem por dois cadastros
  -- gêmeos com o mesmo número. A segunda unicidade tolera NULL (excluído sem
  -- telefone não disputa endereço com ninguém).
  constraint campaign_recipients_contato_unico unique (campaign_id, contact_id),
  constraint campaign_recipients_endereco_unico unique (campaign_id, recipient_address)
);

comment on table public.campaign_recipients is
  'O snapshot: para quem a campanha IA falar, congelado na preparação, com o estado individual de cada envio. Fonte da verdade das métricas — os contadores em campaigns são cache.';
comment on column public.campaign_recipients.recipient_address is
  'Telefone congelado no snapshot. Nunca sai em log (a doutrina proíbe PII em log); quem precisa correlacionar usa o id.';

-- A fila do worker: pendentes de UMA campanha, na ordem de entrada, respeitando
-- reagendamento por ritmo.
create index if not exists idx_campaign_recipients_fila
  on public.campaign_recipients (campaign_id, next_attempt_at, created_at)
  where status in ('pending', 'queued');

-- O caminho do ack: da mensagem de volta ao destinatário.
create index if not exists idx_campaign_recipients_message
  on public.campaign_recipients (message_id)
  where message_id is not null;

-- A pergunta da atribuição de resposta: o envio mais recente a este contato.
create index if not exists idx_campaign_recipients_contato_envio
  on public.campaign_recipients (organization_id, contact_id, sent_at desc);

-- A reconciliação de `sending` travado.
create index if not exists idx_campaign_recipients_enviando
  on public.campaign_recipients (sending_at)
  where status = 'sending';

drop trigger if exists trg_campaigns_updated_at on public.campaigns;
create trigger trg_campaigns_updated_at
  before update on public.campaigns
  for each row execute function public.fn_set_updated_at();

drop trigger if exists trg_campaign_recipients_updated_at on public.campaign_recipients;
create trigger trg_campaign_recipients_updated_at
  before update on public.campaign_recipients
  for each row execute function public.fn_set_updated_at();

-- ═══ Entregue/lido: o ack da mensagem chega ao destinatário ═══
--
-- Não há hook de aplicação para mudança de status de mensagem: o trigger
-- `trg_messages_emit_event` é AFTER **INSERT**, então UPDATE de status não emite
-- evento nenhum (o `recover-stuck-messages` documenta isso e emite à mão). As
-- alternativas eram polling no cron — que só descobre a entrega no tique seguinte
-- e varre a tabela de mensagens — ou este trigger, que é local ao banco, roda na
-- mesma transação do ack e não faz I/O externo (o anti-pattern nº 9 é trigger que
-- fala HTTP; este não fala com ninguém).
--
-- Regra dura: status analítico NUNCA retrocede. `read` não volta para `delivered`,
-- e `replied`/`opted_out`/`cancelled` não voltam para nada — resposta é o desfecho
-- mais forte, e um ack atrasado não pode desfazê-lo.
create or replace function public.fn_campanha_sincroniza_ack() returns trigger
  language plpgsql
  security definer
  set search_path to 'public'
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  update public.campaign_recipients r
     set delivered_at = case
           when new.status in ('delivered', 'read')
             then coalesce(r.delivered_at, new.delivered_at, now())
           else r.delivered_at end,
         read_at = case
           when new.status = 'read' then coalesce(r.read_at, new.read_at, now())
           else r.read_at end,
         sent_at = case
           when new.status in ('sent', 'delivered', 'read')
             then coalesce(r.sent_at, new.sent_at, now())
           else r.sent_at end,
         status = case
           when r.status in ('replied', 'opted_out', 'cancelled') then r.status
           when new.status = 'read' then 'read'
           when new.status = 'delivered' and r.status in ('queued', 'sending', 'sent') then 'delivered'
           when new.status = 'sent' and r.status in ('queued', 'sending') then 'sent'
           when new.status = 'failed' and r.status in ('queued', 'sending', 'sent') then 'failed'
           else r.status end,
         last_error_code = case
           when new.status = 'failed' then coalesce(new.error_code, r.last_error_code)
           else r.last_error_code end,
         last_error_detail = case
           when new.status = 'failed' then coalesce(new.error_message, r.last_error_detail)
           else r.last_error_detail end,
         updated_at = now()
   where r.message_id = new.id;

  return new;
end
$$;

comment on function public.fn_campanha_sincroniza_ack() is
  'Trigger de messages: leva o ack do canal (sent/delivered/read/failed) ao campaign_recipients daquela mensagem. Status analítico nunca retrocede.';

-- As DUAS origens de EXECUTE (CLAUDE.md, doutrina de migrations item 9): o grant
-- que o Postgres dá a PUBLIC ao criar, e o `alter default privileges ... to anon`
-- do baseline, que vale para toda função criada depois dele. `authenticated`
-- entra na lista pelo mesmo motivo. O trigger não depende de nenhum deles: a
-- permissão de função de trigger é conferida na CRIAÇÃO do trigger, não a cada
-- disparo.
revoke execute on function public.fn_campanha_sincroniza_ack() from public, anon, authenticated;
grant execute on function public.fn_campanha_sincroniza_ack() to service_role;

drop trigger if exists trg_messages_sincroniza_campanha on public.messages;
create trigger trg_messages_sincroniza_campanha
  after update of status on public.messages
  for each row
  when (new.direction = 'outbound')
  execute function public.fn_campanha_sincroniza_ack();

-- ═══ LGPD: o contato anonimizado não deixa telefone nem texto para trás ═══
--
-- `campaign_recipients` guarda telefone congelado e o corpo renderizado (que
-- carrega o nome). Anonimizar o contato sem alcançar estas colunas devolveria
-- SUCESSO com o dado legível — a pior falha possível numa obrigação legal,
-- porque nada erra e nada loga.
--
-- TRIGGER e não um 9º passo dentro de `fn_lgpd_cascade_redact_contact`, pelo
-- mesmo motivo escrito no apêndice da 0174: aquela função tem 180 linhas e
-- reescrevê-la aqui criaria duas cópias que divergem no primeiro conserto. O
-- gancho é a transição `is_anonymized false → true`, que é o último fato da
-- anonimização, roda na MESMA transação e alcança QUALQUER caminho que anonimize
-- — inclusive os que não passam pela função.
--
-- O endereço vira NULL e não texto redigido: com NULL, o destinatário pendente
-- cai no veto `sem_telefone` do próximo despacho, e nenhuma mensagem sai para
-- quem exerceu o direito de apagamento. Linha enviada continua contando nas
-- métricas (contagem não é dado pessoal).
create or replace function public.fn_redigir_campanhas_do_contato_anonimizado()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.is_anonymized is true and coalesce(old.is_anonymized, false) is false then
    update public.campaign_recipients
       set recipient_address = null,
           rendered_body = null,
           variables = '{}'::jsonb,
           last_error_detail = null,
           updated_at = now()
     where organization_id = new.organization_id
       and contact_id = new.id;
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_redigir_campanhas_do_contato_anonimizado() from public, anon, authenticated;
grant execute on function public.fn_redigir_campanhas_do_contato_anonimizado() to service_role;

drop trigger if exists trg_redigir_campanhas_anonimizado on public.contacts;
create trigger trg_redigir_campanhas_anonimizado
  after update of is_anonymized on public.contacts
  for each row
  execute function public.fn_redigir_campanhas_do_contato_anonimizado();

-- ═══ RLS ═══
--
-- Padrão da 0261: SELECT aberto ao tenant, ESCRITA a partir de `manager`. Policy
-- `ALL` só-tenancy em tabela nova é reprovada por `rbac-config-ia-canais.test.ts`
-- — e com razão: quem fala direto com o PostgREST usando o próprio JWT não passa
-- pelo `requireRole()` das rotas, e disparar para uma lista de gente não é gesto
-- de `viewer`. `manager` e não `admin` por decisão do dono (2026-09-18): na matriz
-- do PRD §5.2 os dois operam campanha igual.
alter table public.campaigns enable row level security;

drop policy if exists tenant_isolation_campaigns_all on public.campaigns;
drop policy if exists campaigns_select on public.campaigns;
create policy campaigns_select on public.campaigns
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists campaigns_write on public.campaigns;
create policy campaigns_write on public.campaigns
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

revoke all on public.campaigns from anon, authenticated;
grant select on public.campaigns to authenticated;
grant all on public.campaigns to service_role;

alter table public.campaign_recipients enable row level security;

drop policy if exists tenant_isolation_campaign_recipients_all on public.campaign_recipients;
drop policy if exists campaign_recipients_select on public.campaign_recipients;
create policy campaign_recipients_select on public.campaign_recipients
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists campaign_recipients_write on public.campaign_recipients;
create policy campaign_recipients_write on public.campaign_recipients
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

revoke all on public.campaign_recipients from anon, authenticated;
grant select on public.campaign_recipients to authenticated;
grant all on public.campaign_recipients to service_role;

-- ═════ do original: 0375_campanhas_templates_e_exclusoes ═════

-- 0375 — TEMPLATES E LISTA DE EXCLUSÃO DE CAMPANHA (Spec 12 §2.3 e §2.4)
--
-- As duas tabelas ficaram de fora da 0374 por decisão de escopo do dono
-- (2026-09-18: "MVP é texto livre"). Entram agora, pedidas na tela, com a
-- diferença de que não são mais projeto: cada uma resolve um problema medido.
--
-- ═══ `campaign_templates` — a copy que sobrevive à campanha ═══
--
-- Hoje o texto vive dentro de UMA campanha. Quem escreveu uma abordagem que
-- funciona e quer usá-la de novo copia e cola — e a cada cópia a versão boa e a
-- versão velha ficam indistinguíveis. O template guarda a copy fora da execução.
--
-- Conteúdo de campanha JÁ PREPARADA não muda quando o template muda: o texto é
-- congelado por destinatário em `campaign_recipients.rendered_body` com o
-- `content_version` junto. Editar um template amanhã não reescreve o que alguém
-- recebeu ontem.
--
-- ═══ `campaign_suppressions` — parar de falar com alguém sem apagá-lo ═══
--
-- Diferente de opt-out: o opt-out é do TITULAR (ele pediu, e `contacts.is_blocked`
-- responde por isso em todo o produto). A suppression é da OPERAÇÃO — "não
-- mande campanha para este número" — e não deve mexer no cadastro do contato
-- nem no que o agente pode responder quando ELE escreve.
--
-- Guarda HASH e não o telefone: dedup e consulta funcionam igual, e uma lista de
-- "não mandar" não precisa virar um segundo lugar onde telefone de gente mora.
--
-- Mesmo assim ela ENTRA na cascata de anonimização, e a primeira versão deste
-- cabeçalho dizia o contrário: "guarda hash, logo não há PII". O invariante
-- `lgpd-cascata-alcanca-quem-guarda-pessoa` discordou, e estava certo — a linha
-- guarda `contact_id` e os últimos dígitos, e os dois juntos dizem de QUEM ela é.
-- O trigger abaixo apaga esses dois e PRESERVA o hash, que é o veto.

create table if not exists public.campaign_templates (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  body text not null,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaign_templates_name_check check (btrim(name) <> ''),
  constraint campaign_templates_body_check check (btrim(body) <> ''),
  -- Dois templates com o mesmo nome na mesma organização é a receita para usar
  -- o errado: quem escolhe na tela escolhe pelo nome.
  constraint campaign_templates_nome_unico unique (organization_id, name)
);

comment on table public.campaign_templates is
  'Copy reutilizável de campanha. Não é template de provedor (Meta): é texto livre com as mesmas variáveis do renderizador. Campanha preparada não muda quando o template muda — o conteúdo é congelado por destinatário.';

create index if not exists idx_campaign_templates_org
  on public.campaign_templates (organization_id, name);

create table if not exists public.campaign_suppressions (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Nullable: dá para excluir um número que ainda não é contato de ninguém.
  contact_id uuid references public.contacts(id) on delete set null,
  recipient_address_hash text not null,
  -- Só os últimos dígitos, para a tela dizer DE QUEM é a linha sem guardar o
  -- número inteiro. "termina em 4321" basta para a pessoa reconhecer o que ela
  -- mesma cadastrou.
  address_tail text,
  reason text,
  source text not null default 'manual',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint campaign_suppressions_source_check check (source in ('manual', 'import', 'sistema')),
  constraint campaign_suppressions_unico unique (organization_id, recipient_address_hash)
);

comment on table public.campaign_suppressions is
  'Lista de exclusão da OPERAÇÃO: não mandar campanha para este endereço. Diferente do opt-out, que é do titular e vive em contacts.is_blocked — aqui não se mexe no cadastro nem no que o agente responde a quem escreve. Guarda hash, nunca o telefone.';
comment on column public.campaign_suppressions.recipient_address_hash is
  'SHA-256 do telefone normalizado (E.164). O mesmo cálculo mora em lib/campanhas/exclusoes.ts — mudar um lado sem o outro faz a lista parar de casar, em silêncio.';

create index if not exists idx_campaign_suppressions_org
  on public.campaign_suppressions (organization_id, created_at desc);

drop trigger if exists trg_campaign_templates_updated_at on public.campaign_templates;
create trigger trg_campaign_templates_updated_at
  before update on public.campaign_templates
  for each row execute function public.fn_set_updated_at();

-- ═══ LGPD: anonimizar apaga o que APONTA para a pessoa, e preserva o veto ═══
--
-- A lista guarda hash, e hash não reidentifica ninguém. Mas ela guarda também
-- `contact_id` e os últimos dígitos — e esses dois, juntos, dizem de QUEM é a
-- linha. Ao anonimizar, os dois saem.
--
-- O HASH FICA, e isso é deliberado: ele é o veto. Apagá-lo devolveria o número
-- para dentro das campanhas no dia em que o contato fosse anonimizado — o
-- oposto do que o titular pediu. O que sobra é uma linha que impede envio para
-- um número que ninguém consegue ler a partir dela.
create or replace function public.fn_redigir_exclusoes_do_contato_anonimizado()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.is_anonymized is true and coalesce(old.is_anonymized, false) is false then
    update public.campaign_suppressions
       set contact_id = null,
           address_tail = null,
           reason = null
     where organization_id = new.organization_id
       and contact_id = new.id;
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_redigir_exclusoes_do_contato_anonimizado() from public, anon, authenticated;
grant execute on function public.fn_redigir_exclusoes_do_contato_anonimizado() to service_role;

drop trigger if exists trg_redigir_exclusoes_anonimizado on public.contacts;
create trigger trg_redigir_exclusoes_anonimizado
  after update of is_anonymized on public.contacts
  for each row
  execute function public.fn_redigir_exclusoes_do_contato_anonimizado();

-- ═══ RLS — mesmo padrão da 0374 ═══
-- SELECT para o tenant; escrita a partir de `manager`. Policy `ALL` só-tenancy
-- em tabela nova é reprovada por `rbac-config-ia-canais.test.ts`.
alter table public.campaign_templates enable row level security;

drop policy if exists campaign_templates_select on public.campaign_templates;
create policy campaign_templates_select on public.campaign_templates
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists campaign_templates_write on public.campaign_templates;
create policy campaign_templates_write on public.campaign_templates
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

revoke all on public.campaign_templates from anon, authenticated;
grant select on public.campaign_templates to authenticated;
grant all on public.campaign_templates to service_role;

alter table public.campaign_suppressions enable row level security;

drop policy if exists campaign_suppressions_select on public.campaign_suppressions;
create policy campaign_suppressions_select on public.campaign_suppressions
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists campaign_suppressions_write on public.campaign_suppressions;
create policy campaign_suppressions_write on public.campaign_suppressions
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

revoke all on public.campaign_suppressions from anon, authenticated;
grant select on public.campaign_suppressions to authenticated;
grant all on public.campaign_suppressions to service_role;

-- ═════ do original: 0376_campanha_rodizio_de_numeros ═════

-- 0376 — RODÍZIO DE NÚMEROS NA CAMPANHA
--
-- A campanha falava por UM número (`campaigns.channel_session_id`, not null).
-- Passa a poder falar por VÁRIOS, escolhidos explicitamente.
--
-- ═══ Por que uma tabela de vínculo, e não um array de uuid ═══
--
-- O vínculo é tenant-aware e aponta para `channel_sessions`: com array, nenhuma
-- FK protege contra o número de OUTRA organização entrar na lista, e a checagem
-- viraria código que alguém esquece. Com linha, a FK composta
-- `(organization_id, channel_session_id)` recusa no banco — o mesmo padrão da
-- 0260, 0262 e 0374.
--
-- ═══ O que NÃO muda ═══
--
-- `campaigns.channel_session_id` CONTINUA obrigatório e é o número principal:
-- toda campanha que já existe segue funcionando sem uma linha sequer nesta
-- tabela, e quem não quiser rodízio nunca abre essa parte da tela. O pool
-- efetivo é "o principal mais os vinculados".
--
-- ═══ Por que o destinatário guarda o número ═══
--
-- A escolha é feita no ENVIO (quem tem mais folga naquele instante), então só
-- depois de enviar se sabe por onde foi. Sem gravar, a tela precisaria buscar a
-- mensagem para responder "quem falou com esta pessoa?", e o relatório por
-- número viraria um join a mais em cada linha.
--
-- ⚠️ A coluna é NULLABLE e assim fica: destinatário excluído na preparação
-- nunca recebe número, e um default aqui inventaria um envio que não houve.

create table if not exists public.campaign_channel_sessions (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  channel_session_id uuid not null,
  created_at timestamptz not null default now(),
  -- O mesmo número duas vezes na mesma campanha dobraria o peso dele no
  -- rodízio sem ninguém pedir.
  constraint campaign_channel_sessions_unico unique (campaign_id, channel_session_id)
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'campaign_channel_sessions_org_fk'
  ) then
    alter table public.campaign_channel_sessions
      add constraint campaign_channel_sessions_org_fk
      foreign key (organization_id, channel_session_id)
      references public.channel_sessions (organization_id, id)
      on delete cascade;
  end if;
end $$;

comment on table public.campaign_channel_sessions is
  'Os números que UMA campanha pode usar, além do principal em campaigns.channel_session_id. Rodízio: a cada envio o worker escolhe entre eles o que tem mais folga, preferindo aquele em que o contato já conversa.';

create index if not exists idx_campaign_channel_sessions_campanha
  on public.campaign_channel_sessions (campaign_id);

alter table public.campaign_recipients
  add column if not exists channel_session_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'campaign_recipients_channel_org_fk'
  ) then
    alter table public.campaign_recipients
      add constraint campaign_recipients_channel_org_fk
      foreign key (organization_id, channel_session_id)
      references public.channel_sessions (organization_id, id)
      on delete set null;
  end if;
end $$;

comment on column public.campaign_recipients.channel_session_id is
  'Por qual número esta pessoa foi falada. Preenchido no ENVIO, porque é lá que o rodízio decide. NULL = ainda não saiu, ou foi excluída na preparação.';

-- A pergunta do relatório por número: quantas saíram por cada um, nesta campanha.
create index if not exists idx_campaign_recipients_por_numero
  on public.campaign_recipients (campaign_id, channel_session_id)
  where channel_session_id is not null;

-- ═══ RLS — o padrão da 0374/0375 ═══
alter table public.campaign_channel_sessions enable row level security;

drop policy if exists campaign_channel_sessions_select on public.campaign_channel_sessions;
create policy campaign_channel_sessions_select on public.campaign_channel_sessions
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists campaign_channel_sessions_write on public.campaign_channel_sessions;
create policy campaign_channel_sessions_write on public.campaign_channel_sessions
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

revoke all on public.campaign_channel_sessions from anon, authenticated;
grant select on public.campaign_channel_sessions to authenticated;
grant all on public.campaign_channel_sessions to service_role;

-- ═════ do original: 0377_campanha_funil_e_agente ═════

-- 0377 — A CAMPANHA DECLARA FUNIL, ETAPA E AGENTE
--
-- Três colunas nullable em `campaigns`, e o índice que o degrau novo do
-- roteamento precisa. Aditiva: campanha que já existe continua com tudo NULL e
-- se comporta exatamente como antes.
--
-- ═══ `pipeline_id` / `stage_id` — onde o card nasce ═══
--
-- Hoje quem decide o funil de um lead nascido de conversa é o NÚMERO
-- (`crm_pipelines.channel_session_id`, migration 0262), com o funil padrão sem
-- número como reserva. A campanha passa a poder dizer o funil e a etapa, e
-- VENCE o número quando declara — decisão do dono (2026-09-19): quem montou a
-- campanha sabe o que quer medir, e é a escolha mais específica. Quem não
-- declarar continua caindo na regra da 0262, sem mudança nenhuma.
--
-- ═══ `agent_id` — quem atende quem responde ═══
--
-- A dívida estava DECLARADA no repo desde antes desta entrega, em
-- `lib/ai/elegibilidade/campanha.ts`: "encaminhar por campanha exige levar o
-- agent_id (…) e o resolve-turn-agent respeitá-lo — não feito nesta entrega".
-- O schema de lá já aceitava `agent_id` e o ignorava.
--
-- Hoje quem atende a resposta de uma campanha é o agente publicado no NÚMERO,
-- ou o roteador dele. Para prospecção isso é errado por construção: o roteiro
-- de quem aborda é outro, e a LIA-2026-01 promete que quem perguntar "de onde
-- veio meu contato?" recebe a resposta na hora — promessa que só se cumpre se
-- QUEM ATENDE souber respondê-la.
--
-- O agente da campanha só assume conversa que NASCE dela (decisão do dono): o
-- cliente antigo que responde a uma reativação continua com quem já o atendia,
-- em vez de ser sequestrado para o roteiro de prospecção.

alter table public.campaigns add column if not exists pipeline_id uuid;
alter table public.campaigns add column if not exists stage_id uuid;
alter table public.campaigns add column if not exists agent_id uuid;

-- Alvos das FKs compostas: índice único (organization_id, id) em cada tabela.
-- Mesmo cuidado da 0262 — criar só se NÃO houver índice único sobre exatamente
-- essas duas colunas, senão toda instalação ganha um segundo índice idêntico,
-- pago em cada escrita.
do $$
declare
  alvo text;
begin
  foreach alvo in array array['crm_pipelines', 'crm_stages', 'ai_agents'] loop
    if not exists (
      select 1
        from pg_index i
        join pg_class t on t.oid = i.indrelid
       where t.relname = alvo
         and t.relnamespace = 'public'::regnamespace
         and i.indisunique
         and i.indnatts = 2
         and (
           select array_agg(a.attname::text order by k.ord)
             from unnest(i.indkey) with ordinality as k(attnum, ord)
             join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
         ) = array['organization_id', 'id']
    ) then
      execute format('create unique index uq_%s_org_id on public.%I (organization_id, id)', alvo, alvo);
    end if;
  end loop;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'campaigns_pipeline_org_fk') then
    alter table public.campaigns
      add constraint campaigns_pipeline_org_fk
      foreign key (organization_id, pipeline_id)
      references public.crm_pipelines (organization_id, id)
      on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'campaigns_stage_org_fk') then
    alter table public.campaigns
      add constraint campaigns_stage_org_fk
      foreign key (organization_id, stage_id)
      references public.crm_stages (organization_id, id)
      on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'campaigns_agent_org_fk') then
    alter table public.campaigns
      add constraint campaigns_agent_org_fk
      foreign key (organization_id, agent_id)
      references public.ai_agents (organization_id, id)
      on delete set null;
  end if;
end $$;

-- Etapa sem funil seria um card sem coluna: o par anda junto ou não anda.
do $$
begin
  alter table public.campaigns
    add constraint campaigns_etapa_exige_funil
    check (stage_id is null or pipeline_id is not null);
exception when duplicate_object then null; end $$;

comment on column public.campaigns.pipeline_id is
  'Funil em que nasce o card de quem responde. VENCE o funil do número (0262) quando declarado; NULL mantém a regra do número.';
comment on column public.campaigns.agent_id is
  'Quem atende quem responde a esta campanha. Só assume conversa que NASCE da campanha — cliente antigo segue com quem já o atendia. Lido por resolve-turn-agent num degrau acima do roteador.';

-- O degrau novo do roteamento pergunta, a cada turno: esta conversa nasceu de
-- uma campanha com agente? Sem índice, isso seria uma varredura em
-- `campaign_recipients` a cada mensagem recebida da organização inteira.
create index if not exists idx_campaign_recipients_conversa
  on public.campaign_recipients (conversation_id)
  where conversation_id is not null;

-- ═════ MFA provada na REST (migration 0301 deste fork) ═════
--
-- Mesma policy RESTRITIVA que a 0301 aplicou a toda tabela tenant-aware: sem
-- ela, uma sessão aal1 de quem tem fator cadastrado leria e escreveria
-- campanha direto pelo PostgREST, por fora do 403 `mfa_required` das rotas.
do $$
declare t text;
begin
  foreach t in array array['campaigns','campaign_recipients','campaign_templates',
                           'campaign_suppressions','campaign_channel_sessions'] loop
    execute format('drop policy if exists mfa_provada on public.%I', t);
    execute format(
      'create policy mfa_provada on public.%I as restrictive for all to authenticated '
      'using ((select public.fn_session_mfa_proven())) with check ((select public.fn_session_mfa_proven()))',
      t);
  end loop;
end $$;

-- ═════ A campanha entra na cascata de anonimização (0378 no original) ═════
--
-- Porte da 0378 do original (lussandro.ilha, commit 517a8d477), reescrita a
-- partir da definição VIGENTE neste fork (a da migration 0307): o Postgres
-- troca o corpo INTEIRO num `create or replace`, e partir do corpo do original
-- apagaria os passos que este fork acrescentou. Só entra o passo 6c.
CREATE OR REPLACE FUNCTION "public"."fn_lgpd_cascade_redact_contact"("p_organization_id" "uuid", "p_contact_id" "uuid", "p_request_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_already bool;
  v_counts jsonb := '{}'::jsonb;
  v_media_paths text[] := '{}';
  v_anon_label text;
  v_count int;
begin
  perform public.fn_service_lock(p_organization_id,p_contact_id);
  select is_anonymized into v_already
    from contacts
    where id = p_contact_id and organization_id = p_organization_id;

  if not found then
    raise exception 'contact not found' using errcode = 'P0002';
  end if;

  if v_already then
    return jsonb_build_object('already_anonymized', true, 'counts', v_counts, 'media_paths', v_media_paths);
  end if;

  v_anon_label := 'Cliente Anonimizado #' || substring(p_contact_id::text from 1 for 8);

  -- Collect media storage paths (we only delete what we own — media_storage_path)
  select coalesce(array_agg(distinct media_storage_path) filter (where media_storage_path is not null), '{}')
    into v_media_paths
    from messages
    where organization_id = p_organization_id
      and conversation_id in (
        select id from conversations
          where contact_id = p_contact_id and organization_id = p_organization_id
      );

  -- 1. contacts (irreversible)
  update contacts set
    name = v_anon_label,
    display_name = v_anon_label,
    email = null,
    -- email_normalized NÃO entra: é GENERATED ALWAYS AS (lower(trim(email)))
    -- e o Postgres recusa escrita nela — a linha acima já a zera por derivação.
    -- Com a atribuição, o cascade INTEIRO abortava e nada era anonimizado.
    phone_number = null,
    cpf_encrypted = null,
    cpf_hash = null,
    birthdate = null,
    is_anonymized = true,
    anonymized_at = now(),
    consent = '{}'::jsonb,
    source_metadata = '{}'::jsonb,
    tags = '{}'::text[],
    updated_at = now()
  where id = p_contact_id and organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('contacts', v_count);

  -- 2. conversations metadata + preview strip
  update conversations set
    metadata = '{}'::jsonb,
    last_message_preview = null,
    updated_at = now()
  where contact_id = p_contact_id and organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('conversations', v_count);

  -- 3. messages: redact body + null media + strip metadata (preserve status/timestamps/conversation_id)
  update messages set
    body = '[mensagem anonimizada]',
    media_url = null,
    media_mime = null,
    media_size_bytes = null,
    media_storage_path = null,
    media_derived_text = null,
    metadata = '{}'::jsonb,
    updated_at = now()
  where organization_id = p_organization_id
    and conversation_id in (
      select id from conversations
        where contact_id = p_contact_id and organization_id = p_organization_id
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('messages', v_count);

  -- 4. crm_lead_activities — strip payload, metadata E reason (migration 0071).
  --    `reason` é texto livre escrito por LLM sobre a conversa do lead: supor que
  --    nunca conterá um nome é a suposição que falha. `evidence` NÃO é limpa —
  --    guarda só ids, e as linhas apontadas são redigidas por conta própria.
  update crm_lead_activities set
    payload = '{}'::jsonb,
    metadata = '{}'::jsonb,
    reason = null
  where organization_id = p_organization_id
    and (
      contact_id = p_contact_id
      or lead_id in (
        select lead_id from crm_lead_links
          where target_kind = 'contact'
            and target_id = p_contact_id
            and organization_id = p_organization_id
      )
      or lead_id in (
        select id from crm_leads
          where contact_id = p_contact_id and organization_id = p_organization_id
      )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('activities', v_count);

  -- 5. crm_leads — strip title/description/custom_fields/source_metadata/tags but PRESERVE pipeline/stage/value
  update crm_leads set
    title = v_anon_label,
    description = null,
    custom_fields = '{}'::jsonb,
    source_metadata = '{}'::jsonb,
    tags = '{}'::text[],
    updated_at = now()
  where organization_id = p_organization_id
    and (
      contact_id = p_contact_id
      or id in (
        select lead_id from crm_lead_links
          where target_kind = 'contact'
            and target_id = p_contact_id
            and organization_id = p_organization_id
      )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('leads', v_count);

  -- 6. orders — PRESERVE values + status + timestamps. Strip personal fields from payload jsonb
  --    and replace customer_external_id with null (FK-safe; soft de-link). Keep contact_id null.
  update orders set
    payload = (coalesce(payload, '{}'::jsonb))
      - 'customer'
      - 'customer_name'
      - 'customer_email'
      - 'customer_phone'
      - 'shipping_address'
      - 'billing_address'
      - 'contact_identification',
    customer_external_id = null,
    contact_id = null,
    is_anonymized = true,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('orders', v_count);

  -- 6c. CAMPANHAS (migration 0316; 0378 no original, de lussandro.ilha) — o
  --     que foi DITO à pessoa e o endereço para onde foi. `rendered_body` é a
  --     mensagem que ela recebeu e `recipient_address` o telefone. A LINHA
  --     FICA: é a prova de que a pessoa esteve naquela campanha, e apagá-la
  --     desfaria a contagem de quem recebeu.
  update campaign_recipients set
    rendered_body = null,
    recipient_address = null,
    variables = '{}'::jsonb,
    last_error_detail = null,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('campaign_recipients', v_count);

  --     LISTA DE EXCLUSÃO: solta o vínculo e apaga a cauda do telefone. O HASH
  --     do endereço PERMANECE de propósito: é ele que faz o "não me mande
  --     mais" continuar valendo depois da anonimização.
  update campaign_suppressions set
    address_tail = null,
    reason = null,
    contact_id = null
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('campaign_suppressions', v_count);

  -- 6d. conversation_notes (migration 0303) — a nota interna é texto escrito
  -- SOBRE a pessoa durante o atendimento, e o anexo dela é mídia ancorada na
  -- conversa: os dois entram no alcance do titular. O arquivo vai para a fila
  -- ANTES de a coluna ser zerada, com o bucket `internal-media` — a nota nunca
  -- sobe no `whatsapp-media` (bucket do canal do cliente), e enfileirar o
  -- caminho num bucket onde ele não está faria a remoção mirar no nada. Por
  -- isso esses caminhos também NÃO entram em `v_media_paths` (passo 7).
  insert into storage_redaction_queue (organization_id, request_id, bucket, object_path)
  select p_organization_id, p_request_id, 'internal-media', n.media_storage_path
    from conversation_notes n
   where n.organization_id = p_organization_id
     and n.conversation_id in (
       select id from conversations
        where contact_id = p_contact_id and organization_id = p_organization_id
     )
     and n.media_storage_path is not null and length(n.media_storage_path) > 0
     and n.media_storage_path like p_organization_id::text || '/%'
  on conflict (bucket, object_path) do nothing;
  update conversation_notes set
    body = '[nota interna anonimizada]',
    media_storage_path = null,
    media_mime = null,
    media_size_bytes = null
  where organization_id = p_organization_id
    and conversation_id in (
      select id from conversations
       where contact_id = p_contact_id and organization_id = p_organization_id
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('conversation_notes', v_count);

  -- 7. enqueue media for async deletion (idempotent via unique (bucket, object_path))
  if array_length(v_media_paths, 1) > 0 then
    insert into storage_redaction_queue (organization_id, request_id, bucket, object_path)
    select p_organization_id, p_request_id, 'whatsapp-media', path
      from unnest(v_media_paths) as path
      where path is not null and length(path) > 0
    on conflict (bucket, object_path) do nothing;
  end if;

  -- 7b. voice_calls — o TELEFONE de quem falou ao telefone (migration 0235).
  --
  -- `peer_phone` é `not null` e guarda o número da outra ponta: depois de
  -- anonimizar o contato, ele sobrevivia ligado ao `contact_id` e reidentificava
  -- a pessoa que pediu para ser esquecida. É o mesmo argumento que a foto de
  -- perfil já tinha (ver o bloco do avatar em `lib/lgpd/redact-cascade.ts`):
  -- anonimizar em toda parte menos numa é não ter anonimizado.
  --
  -- O que fica: direção, status, motivo do fim, marcas de tempo e duração. Um
  -- registro de "houve uma chamada de 12 minutos" sem número e sem dono não
  -- identifica ninguém e é o que sustenta a métrica do atendente e a fatura.
  -- `peer_phone` é NOT NULL, então recebe o rótulo, não `null`.
  update voice_calls set
    peer_phone = v_anon_label,
    owner_user_id = null,
    created_by = null,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('voice_calls', v_count);

  -- 7c. contact_channel_identities — handle/nome/avatar do Instagram (migration 0277).
  --     external_id e channel FICAM: são o apontador técnico (o IGSID da Meta),
  --     não conteúdo da pessoa, e apagá-los faria o próximo evento do MESMO
  --     IGSID criar um contato NOVO em vez de reconhecer o já anonimizado.
  update contact_channel_identities set
    handle = null,
    display_name = null,
    avatar_url = null,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('contact_channel_identities', v_count);

  -- 8. dense audit row
  insert into api_audit_log (organization_id, action, actor_user_id, resource_type, resource_id, metadata, bypassed_rls)
  values (
    p_organization_id,
    'lgpd.redact_executed',
    null,
    'contact',
    p_contact_id,
    jsonb_build_object(
      'cascaded_to', v_counts,
      'media_queued', coalesce(array_length(v_media_paths, 1), 0),
      'request_id', p_request_id
    ),
    true
  );

  return jsonb_build_object(
    'already_anonymized', false,
    'counts', v_counts,
    'media_paths', v_media_paths
  );
end;
$$;

revoke all on function public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid) to service_role;
