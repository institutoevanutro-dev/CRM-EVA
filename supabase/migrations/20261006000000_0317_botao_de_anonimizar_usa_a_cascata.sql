-- 0317 — o botão "Anonimizar" da ficha passa a limpar tudo o que o pedido formal
--        limpa, e a anonimização alcança o caso que a IA abriu sobre a pessoa
--
-- Porte do DeskcommCRM original, reescrito sobre as funções VIGENTES deste fork:
--   * commits e8e5252b8, e74e343ae, 3eaf5b5fe, ca39e824e e 0fb069e44, de
--     webtecnica, issue #1504 (migration 0414 de lá) — o botão chama a cascata;
--   * commit 50ede48cb (migration 0280 de lá) — a cascata alcança o caso.
--
-- ─── O defeito ────────────────────────────────────────────────────────────
--
-- Há dois caminhos para anonimizar um contato, e eles apagavam coisas diferentes:
--
--   fn_lgpd_cascade_redact_contact   pedido formal (lib/lgpd/redact-cascade.ts)
--   fn_lgpd_anonymize_contact        botão da ficha (/api/v1/lgpd/anonymize)
--
-- O botão reescrevia nome, e-mail, telefone, CPF e nascimento, e os gatilhos da
-- virada de `is_anonymized` (0308, 0309, 0312) cuidavam de conversa, mensagens,
-- notas e memória da IA. Ficavam para trás, medido no banco deste fork:
--
--   contacts.consent / source_metadata / tags — e é em `source_metadata` que o
--     fork guarda o @ do Instagram (`handle`), o telefone em conflito
--     (`telefone_em_conflito`) e o LID do WhatsApp (`waha_lid`, de onde as
--     colunas geradas `wa_identity` e `wa_lid` saem);
--   contacts.avatar_storage_path — a foto de perfil e o arquivo no bucket;
--   contact_channel_identities — @, nome e foto do Instagram;
--   crm_leads (descrição, campos, etiquetas e 20 letras do título),
--   crm_lead_activities (metadata, reason), orders, voice_calls (o telefone).
--
-- ─── O que muda ───────────────────────────────────────────────────────────
--
-- 1. `fn_lgpd_anonymize_contact` vira só o PORTÃO: confere quem pode (papel,
--    suporte, MFA), pega a trava na mesma ordem de antes, devolve a data
--    original na retomada — e a redação em si passa a ser a da cascata do
--    pedido formal. O `update public.contacts` sai do corpo: quem escreve o
--    contato é a cascata. `p_request_id` vai nulo (não há pedido de titular);
--    a fila de mídia e a auditoria já aceitam nulo (é como o gatilho da 0308
--    enfileira).
--    O rótulo passa a ser o da cascata, `Cliente Anonimizado #<8>`, nos dois
--    campos de nome — um rótulo só para a mesma operação.
--
-- 2. A cascata ganha o que faltava nos DOIS caminhos (derivada do corpo
--    vigente, o da 0316 — só entram passos; nenhum passo anterior muda de
--    alcance, exceto o 7c, descrito abaixo):
--
--    0b  foto de perfil: o arquivo vai para a fila de remoção e o ponteiro é
--        apagado. No pedido formal quem fazia era o app, antes de chamar a
--        função; pelo botão ninguém fazia.
--    2   a conversa do Instagram perde `provider_conversation_id`, que nela é
--        o IGSID da pessoa (0278).
--    7c-1 comentários do Instagram da pessoa (achados pelo IGSID): saem texto,
--        @, IGSID, sugestão de resposta e motivo; a linha fica.
--    7c  a identidade do canal perde também o IGSID (`external_id`). A 0277 o
--        mantinha para o próximo evento cair no contato anonimizado; isso
--        deixava a pessoa reidentificável (IGSID + token da página devolvem @
--        e nome) e presa a um contato que não pode ser editado. Passa a valer
--        o mesmo do WhatsApp: quem volta a escrever é um contato novo.
--    7d  agent_cases: título, resumo, bloqueio e o recorte da conversa que foi
--        ao modelo. `updated_at` fica fora (o cobrador de caso parado o lê).
--    7e  agent_case_events: corpo e metadata da linha do tempo do caso.
--    7f  demandas: o assunto e o próximo passo.
--    7g  agent_inbox_items: todo aviso da Central que aponta para a pessoa
--        (contato, conversa, caso, follow-up ou compromisso dela) é resolvido
--        e perde título, corpo e referência.
--
--    Nenhum caminho alcançava 7d–7g: o relato que a IA escreveu sobre o
--    paciente sobrevivia à anonimização, com o relatório dizendo "executado".
--
-- 3. Cura de quem JÁ estava anonimizado (fim do arquivo).
--
-- 4. Só no baseline.sql: o backfill da 0278 ("destinatário das conversas do
--    Instagram") passa a ignorar a identidade anonimizada. Ele preenche o
--    destinatário vazio com o `external_id` da identidade única — e, depois do
--    7c, esse valor é a marca `anonimizado:<id>`. Sem a guarda, cada
--    `update.sh` gravava a marca como destinatário e o A2 da cura a apagava em
--    seguida. A migration 0278 em si não muda: rodou uma vez, antes de a marca
--    existir.
--
-- O que NÃO muda: assinaturas (lib/database.types.ts igual), policies, grants,
-- gatilhos. Nenhuma tabela ou coluna nova.

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
  v_igsids text[] := '{}';
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

  -- 0b. FOTO DE PERFIL (migration 0317) — o arquivo vai para a fila ANTES de o
  --     passo 1 apagar o caminho. Sem a fila, zerar o ponteiro deixaria o rosto
  --     da pessoa no bucket sem ninguém saber onde. No pedido formal quem faz
  --     isto é `lib/lgpd/redact-cascade.ts`, antes de chamar esta função (o
  --     caminho já chega nulo aqui e este passo não acha nada); pelo botão da
  --     ficha ninguém fazia. `do update` REABRE a linha: o caminho do avatar é
  --     estável por contato, e uma linha terminal de um pedido antigo nunca
  --     seria drenada de novo.
  insert into storage_redaction_queue (organization_id, request_id, bucket, object_path)
  select p_organization_id, p_request_id, 'whatsapp-media', c.avatar_storage_path
    from contacts c
   where c.id = p_contact_id and c.organization_id = p_organization_id
     and c.avatar_storage_path is not null and length(c.avatar_storage_path) > 0
  on conflict (bucket, object_path) do update set
    status = 'pending',
    attempts = 0,
    processed_at = null,
    error_message = null,
    request_id = coalesce(excluded.request_id, storage_redaction_queue.request_id);

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
    avatar_updated_at = case when avatar_storage_path is not null then now() else avatar_updated_at end,
    avatar_storage_path = null,
    updated_at = now()
  where id = p_contact_id and organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('contacts', v_count);

  -- 2. conversations metadata + preview strip
  update conversations set
    metadata = '{}'::jsonb,
    last_message_preview = null,
    -- (migration 0317) Na conversa do Instagram este campo É o IGSID da pessoa
    -- (0278). Nos outros canais é id de conversa do provedor, e fica.
    provider_conversation_id = case when channel = 'instagram' then null else provider_conversation_id end,
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

  -- 7c-0. Os IGSIDs desta pessoa, lidos ANTES de o 7c apagá-los: é por eles
  --       que os comentários abaixo são achados (migration 0317).
  select coalesce(array_agg(external_id), '{}') into v_igsids
    from contact_channel_identities
   where organization_id = p_organization_id
     and contact_id = p_contact_id
     and channel = 'instagram';

  -- 7c-1. instagram_comments (migration 0317) — o que a pessoa comentou num
  --       post da clínica. A ingestão não grava `contact_id` (quem liga o
  --       comentário à pessoa é o IGSID de quem comentou), então o predicado
  --       tem os dois braços. Saem o texto, o @, o IGSID, a sugestão de
  --       resposta e o motivo do toque; a LINHA fica (post, data, desfecho),
  --       porque é dela que sai a contagem de comentários atendidos. Quem ainda
  --       esperava resposta sai da fila: não há mais o que responder, e o
  --       worker não pode responder a um comentário sem texto.
  update instagram_comments set
    texto = null,
    autor_handle = null,
    autor_igsid = 'anonimizado',
    sugestao_de_resposta = null,
    motivo_do_toque = null,
    situacao = case when situacao in ('novo', 'esperando_voce') then 'ignorado' else situacao end,
    updated_at = now()
  where organization_id = p_organization_id
    and (contact_id = p_contact_id or autor_igsid = any(v_igsids));
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('instagram_comments', v_count);

  -- 7c. contact_channel_identities — handle/nome/avatar do Instagram (migration 0277)
  --     e, desde a 0317, o IGSID. A 0277 guardava o `external_id` para o
  --     próximo evento do mesmo IGSID cair no contato já anonimizado. Isso
  --     deixava a pessoa reidentificável (com o IGSID e o token da página a
  --     Meta devolve o @ e o nome) e presa para sempre a um contato que não
  --     pode mais ser editado. Agora é como no WhatsApp, onde o telefone some:
  --     quem volta a escrever depois de anonimizado é um contato NOVO. A linha
  --     fica (a coluna é NOT NULL e única por organização — recebe uma marca
  --     própria): registra que houve uma identidade naquele canal.
  update contact_channel_identities set
    handle = null,
    display_name = null,
    avatar_url = null,
    external_id = 'anonimizado:' || id::text,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('contact_channel_identities', v_count);

  -- 7d. agent_cases — o que a IA escreveu SOBRE a pessoa quando travou
  --     (migration 0317; 0280 no original).
  --
  -- O caso é o texto que a equipe lê antes de decidir: `title`, `summary` e
  -- `blocker` saem do modelo a partir da conversa, e `context_snapshot` é o
  -- recorte dessa conversa que o motor mandou para ele. Nada disso é registro
  -- de operação — é o relato do problema de uma pessoa identificável. As três
  -- colunas de texto são NOT NULL: recebem rótulo e texto fixo, nunca `null`.
  --
  -- ⚠️ `updated_at` FICA FORA DO `set`, de propósito. O cobrador de caso parado
  -- (`app/api/v1/cron/case-stale-watcher/route.ts`) o lê como "alguém da equipe
  -- encostou neste caso". A cascata não é alguém encostando: escrever ali
  -- adiaria a cobrança de um caso que continua parado.
  --
  -- O vínculo é pela CONVERSA porque `agent_cases` não tem FK para `contacts`.
  update agent_cases set
    title = v_anon_label,
    summary = '[resumo anonimizado]',
    blocker = '[bloqueio anonimizado]',
    context_snapshot = '{}'::jsonb
  where organization_id = p_organization_id
    and conversation_id in (
      select id from conversations
        where contact_id = p_contact_id and organization_id = p_organization_id
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('agent_cases', v_count);

  -- 7e. agent_case_events — a linha do tempo do caso. `body` é o que a pessoa
  --     da equipe escreveu ao responder e o que o agente registrou sobre o que
  --     o cliente disse; `metadata` leva o recorte que o motor anexou. `kind`,
  --     `actor_kind`, `human_action` e `created_at` FICAM: são o registro de
  --     que houve um toque humano e quando.
  update agent_case_events set
    body = null,
    metadata = '{}'::jsonb
  where organization_id = p_organization_id
    and case_id in (
      select id from agent_cases
        where organization_id = p_organization_id
          and conversation_id in (
            select id from conversations
              where contact_id = p_contact_id and organization_id = p_organization_id
          )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('agent_case_events', v_count);

  -- 7f. demandas — o assunto do pedido e o próximo passo, os dois texto livre
  --     sobre o que a pessoa pediu ("Ligar para a Maria sobre o exame"). O
  --     resto da linha é a operação da demanda (origem, estado, dono, prazo,
  --     desfecho) e fica. O próximo passo vira texto FIXO, não nulo: demanda
  --     aberta sem próximo passo entra no Radar como "ninguém marcou o que
  --     fazer", e cobraria a equipe por quem pediu para ser esquecido.
  update demandas set
    assunto = null,
    proximo_passo = case when proximo_passo is null then null else '[próximo passo anonimizado]' end
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('demandas', v_count);

  -- 7g. agent_inbox_items — os avisos da Central sobre esta pessoa.
  --
  -- O original redige só `handoff` e `case_stale`. Medido nos produtores DESTE
  -- fork, outros tipos também levam dado da pessoa: `voice_call_missed` põe o
  -- TELEFONE no título (`lib/wacalls/events-bridge.ts`), o `handoff` do motor
  -- leva o resumo da conversa (`lib/agent-engine/agent/human-handoff.ts`),
  -- `next_action_ambiguous` cita a proposta, `supervision_review` leva texto da
  -- revisão, `case_stale` embute o título do caso. Uma lista de tipos escrita
  -- aqui envelheceria no próximo tipo novo — e tipo fora da lista casa zero
  -- linha e devolve sucesso. Por isso a regra é pela REFERÊNCIA: todo aviso
  -- que aponta para o contato, uma conversa, um caso, um follow-up ou um
  -- compromisso dele. Sai o texto (título e corpo), a referência é solta e o
  -- aviso é resolvido; o tipo, a severidade e as datas ficam.
  --
  -- A referência é polimórfica (sem FK). O `ref_kind` não entra no predicado de
  -- propósito: o mesmo contato aparece como `contact`, `lgpd_escalation` e
  -- `jailbreak_escalation`, e um id de contato não é id de mais nada.
  --
  -- Ficam de fora dois tipos que só usam a conversa como exemplo de um
  -- problema da ORGANIZAÇÃO (`message_send_stuck`, `capabilities_missing`): o
  -- texto deles é fixo, sem dado da pessoa, e resolvê-los esconderia um
  -- defeito que continua de pé.
  update agent_inbox_items set
    status = 'resolved',
    resolved_at = coalesce(resolved_at, now()),
    title = 'Aviso de contato anonimizado',
    body = 'Contato anonimizado.',
    ref_id = null
  where organization_id = p_organization_id
    and kind not in ('message_send_stuck', 'capabilities_missing')
    and ref_id is not null
    and (
      ref_id = p_contact_id
      or ref_id in (
        select id from conversations
          where contact_id = p_contact_id and organization_id = p_organization_id)
      or ref_id in (
        select id from agent_cases
          where organization_id = p_organization_id
            and conversation_id in (
              select id from conversations
                where contact_id = p_contact_id and organization_id = p_organization_id))
      or ref_id in (
        select id from followup_enrollments
          where contact_id = p_contact_id and organization_id = p_organization_id)
      or ref_id in (
        select id from calendar_appointments
          where contact_id = p_contact_id and organization_id = p_organization_id)
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('agent_inbox_items', v_count);

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

-- O PORTÃO do botão da ficha. Derivado da definição vigente (0229): autoridade,
-- MFA, trava ANTES do `for update` e o retorno `{already_anonymized,
-- anonymized_at}` ficam como estavam. Só o miolo muda: em vez de reescrever o
-- contato por conta própria, chama a cascata do pedido formal.
create or replace function public.fn_lgpd_anonymize_contact(p_organization_id uuid,p_contact_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare c public.contacts; support jsonb; v_quando timestamptz;
begin
 support:=public.fn_support_context();
 if auth.uid() is null or not public.fn_support_write_allowed(p_organization_id)
  or not (public.fn_role_at_least(p_organization_id,'admin') or (public.fn_is_platform_admin() and support is null)) then
  raise exception 'contact_anonymize_forbidden' using errcode='42501';
 end if;
 if not public.fn_session_mfa_proven() then raise exception 'contact_anonymize_mfa_required' using errcode='42501';end if;
 perform public.fn_service_lock(p_organization_id,p_contact_id);
 select * into c from public.contacts where organization_id=p_organization_id and id=p_contact_id for update;
 if not found then raise exception 'contact_not_found' using errcode='P0002';end if;
 if c.is_anonymized then return jsonb_build_object('already_anonymized',true,'anonymized_at',c.anonymized_at);end if;
 -- A redação é da função ÚNICA. Nada é escrito por conta própria neste corpo:
 -- um `update` colado aqui faria os dois caminhos divergirem de novo.
 perform public.fn_lgpd_cascade_redact_contact(p_organization_id,p_contact_id,null);
 select anonymized_at into v_quando
   from public.contacts where organization_id=p_organization_id and id=p_contact_id;
 return jsonb_build_object('already_anonymized',false,'anonymized_at',v_quando);
end;$$;
revoke all on function public.fn_lgpd_anonymize_contact(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.fn_lgpd_anonymize_contact(uuid,uuid) to authenticated;

-- Cura: contatos JÁ anonimizados antes desta migration.
--
-- Idempotente: cada comando só toca linha com resíduo, e a reaplicação do
-- baseline no update.sh não acha mais nada. Nenhum comando alcança contato que
-- não esteja anonimizado. Linha de tabela filha só entra se já existia até
-- `anonymized_at` — o que nasceu depois é dado novo, e não é desta cura
-- (mesmo critério das 0308, 0309 e 0312).
--
-- ── (A) TODOS os anonimizados, por qualquer caminho: o que a 0317 acrescenta ──

-- A1. Comentários do Instagram. ANTES do A3, que apaga o IGSID por onde o
--     comentário é achado.
update public.instagram_comments ic set
  texto = null,
  autor_handle = null,
  autor_igsid = 'anonimizado',
  sugestao_de_resposta = null,
  motivo_do_toque = null,
  situacao = case when ic.situacao in ('novo', 'esperando_voce') then 'ignorado' else ic.situacao end,
  updated_at = now()
  from public.contacts k
 where k.is_anonymized
   and k.organization_id = ic.organization_id
   and ic.created_at <= k.anonymized_at
   and ic.autor_igsid <> 'anonimizado'
   and (ic.contact_id = k.id
        or ic.autor_igsid in (
          select i.external_id from public.contact_channel_identities i
           where i.organization_id = k.organization_id and i.contact_id = k.id and i.channel = 'instagram'));

-- A2. A conversa do Instagram perde o destinatário (o IGSID).
update public.conversations c set
  provider_conversation_id = null
  from public.contacts k
 where k.id = c.contact_id
   and k.organization_id = c.organization_id
   and k.is_anonymized
   and c.channel = 'instagram'
   and c.provider_conversation_id is not null;

-- A3. A identidade do canal perde @, nome, foto e o IGSID.
update public.contact_channel_identities i set
  handle = null,
  display_name = null,
  avatar_url = null,
  external_id = 'anonimizado:' || i.id::text
  from public.contacts k
 where k.id = i.contact_id
   and k.organization_id = i.organization_id
   and k.is_anonymized
   and (i.external_id not like 'anonimizado:%'
        or i.handle is not null or i.display_name is not null or i.avatar_url is not null);

-- A4. Foto de perfil: o arquivo vai para a fila ANTES de o ponteiro ser apagado.
insert into public.storage_redaction_queue (organization_id, bucket, object_path)
select k.organization_id, 'whatsapp-media', k.avatar_storage_path
  from public.contacts k
 where k.is_anonymized
   and k.avatar_storage_path is not null
   and length(k.avatar_storage_path) > 0
on conflict (bucket, object_path) do update set
  status = 'pending', attempts = 0, processed_at = null, error_message = null;

update public.contacts set
  avatar_storage_path = null,
  avatar_updated_at = now()
 where is_anonymized
   and avatar_storage_path is not null;

-- A5. O caso que a IA abriu: título, resumo, bloqueio e o recorte da conversa.
--     `updated_at` fica fora, como na cascata.
update public.agent_cases ac set
  title = 'Cliente Anonimizado #' || substring(k.id::text from 1 for 8),
  summary = '[resumo anonimizado]',
  blocker = '[bloqueio anonimizado]',
  context_snapshot = '{}'::jsonb
  from public.conversations c, public.contacts k
 where c.id = ac.conversation_id
   and c.organization_id = ac.organization_id
   and k.id = c.contact_id
   and k.organization_id = c.organization_id
   and k.is_anonymized
   and ac.created_at <= k.anonymized_at
   and (ac.summary <> '[resumo anonimizado]'
        or ac.blocker <> '[bloqueio anonimizado]'
        or ac.context_snapshot <> '{}'::jsonb);

-- A6. A linha do tempo do caso.
update public.agent_case_events e set
  body = null,
  metadata = '{}'::jsonb
  from public.agent_cases ac, public.conversations c, public.contacts k
 where ac.id = e.case_id
   and ac.organization_id = e.organization_id
   and c.id = ac.conversation_id
   and c.organization_id = ac.organization_id
   and k.id = c.contact_id
   and k.organization_id = c.organization_id
   and k.is_anonymized
   and e.created_at <= k.anonymized_at
   and (e.body is not null or e.metadata <> '{}'::jsonb);

-- A7. A demanda: assunto e próximo passo.
update public.demandas d set
  assunto = null,
  proximo_passo = case when d.proximo_passo is null then null else '[próximo passo anonimizado]' end
  from public.contacts k
 where k.id = d.contact_id
   and k.organization_id = d.organization_id
   and k.is_anonymized
   and d.created_at <= k.anonymized_at
   and (d.assunto is not null
        or (d.proximo_passo is not null and d.proximo_passo <> '[próximo passo anonimizado]'));

-- A8. Os avisos da Central sobre a pessoa (mesma regra do passo 7g). Aviso já
--     tratado fica sem referência e não é achado de novo. A lista de
--     referências é montada a partir dos anonimizados (poucos), e só então
--     casada com os avisos — reaplicar o baseline não varre a Central inteira
--     contato por contato.
--
--     `corte` é até quando um aviso é dado ANTIGO. Para contato, conversa,
--     follow-up e compromisso é `anonymized_at`, como nas outras curas. Para o
--     CASO aberto antes da anonimização não há corte: o cobrador de caso parado
--     (`case-stale-watcher`) seguiu abrindo avisos sobre ele depois, e cada um
--     copia no corpo o título que a IA escreveu ANTES — a data do aviso é nova,
--     o texto não. Caso aberto depois é dado novo e fica fora (como no A5).
update public.agent_inbox_items a set
  status = 'resolved',
  resolved_at = coalesce(a.resolved_at, now()),
  title = 'Aviso de contato anonimizado',
  body = 'Contato anonimizado.',
  ref_id = null
  from (
    select k.organization_id, k.anonymized_at as corte, k.id as ref
      from public.contacts k
     where k.is_anonymized
    union all
    select k.organization_id, k.anonymized_at, c.id
      from public.contacts k
      join public.conversations c on c.contact_id = k.id and c.organization_id = k.organization_id
     where k.is_anonymized
    union all
    select k.organization_id, 'infinity'::timestamptz, ac.id
      from public.contacts k
      join public.conversations c on c.contact_id = k.id and c.organization_id = k.organization_id
      join public.agent_cases ac on ac.conversation_id = c.id and ac.organization_id = c.organization_id
     where k.is_anonymized
       and ac.created_at <= k.anonymized_at
    union all
    select k.organization_id, k.anonymized_at, f.id
      from public.contacts k
      join public.followup_enrollments f on f.contact_id = k.id and f.organization_id = k.organization_id
     where k.is_anonymized
    union all
    select k.organization_id, k.anonymized_at, ap.id
      from public.contacts k
      join public.calendar_appointments ap on ap.contact_id = k.id and ap.organization_id = k.organization_id
     where k.is_anonymized
  ) r
 where a.organization_id = r.organization_id
   and a.ref_id = r.ref
   and a.created_at <= r.corte
   and a.kind not in ('message_send_stuck', 'capabilities_missing');

-- ── (B) Só quem foi anonimizado pelo BOTÃO ANTIGO ──
--
-- A marca é a que só ele deixava: `name` nulo e o rótulo `Contato Anonimizado
-- #…` (a cascata grava `Cliente Anonimizado #…` nos dois campos). São os
-- passos da cascata que o botão nunca rodou. O último comando troca o rótulo
-- pelo da cascata — é ele que faz a cura não se repetir: enquanto o contato
-- tiver a marca antiga, os comandos acima dele voltam a rodar e chegam ao
-- mesmo resultado.

-- B1. Atividades: payload, metadata e o motivo escrito pela IA.
update public.crm_lead_activities a set
  payload = '{}'::jsonb,
  metadata = '{}'::jsonb,
  reason = null
  from public.contacts k
 where k.is_anonymized
   and k.name is null
   and k.display_name like 'Contato Anonimizado #%'
   and a.organization_id = k.organization_id
   and a.created_at <= k.anonymized_at
   and (a.contact_id = k.id
        or a.lead_id in (
          select l.id from public.crm_leads l
           where l.contact_id = k.id and l.organization_id = k.organization_id)
        or a.lead_id in (
          select ll.lead_id from public.crm_lead_links ll
           where ll.target_kind = 'contact' and ll.target_id = k.id and ll.organization_id = k.organization_id))
   and (a.payload <> '{}'::jsonb or a.metadata <> '{}'::jsonb or a.reason is not null);

-- B2. Negócios: o botão antigo deixava 20 letras do título, a descrição, os
--     campos e as etiquetas. Funil, etapa e valor ficam.
update public.crm_leads l set
  title = 'Cliente Anonimizado #' || substring(k.id::text from 1 for 8),
  description = null,
  custom_fields = '{}'::jsonb,
  source_metadata = '{}'::jsonb,
  tags = '{}'::text[],
  updated_at = now()
  from public.contacts k
 where k.is_anonymized
   and k.name is null
   and k.display_name like 'Contato Anonimizado #%'
   and l.organization_id = k.organization_id
   and l.created_at <= k.anonymized_at
   and (l.contact_id = k.id
        or l.id in (
          select ll.lead_id from public.crm_lead_links ll
           where ll.target_kind = 'contact' and ll.target_id = k.id and ll.organization_id = k.organization_id));

-- B3. Chamadas de voz: o telefone de quem falou.
update public.voice_calls v set
  peer_phone = 'Cliente Anonimizado #' || substring(k.id::text from 1 for 8),
  owner_user_id = null,
  created_by = null,
  updated_at = now()
  from public.contacts k
 where k.is_anonymized
   and k.name is null
   and k.display_name like 'Contato Anonimizado #%'
   and v.organization_id = k.organization_id
   and v.contact_id = k.id
   and v.created_at <= k.anonymized_at;

-- B4. Pedidos: saem os dados pessoais do payload e o vínculo; valor, situação
--     e datas ficam.
update public.orders o set
  payload = (coalesce(o.payload, '{}'::jsonb))
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
  from public.contacts k
 where k.is_anonymized
   and k.name is null
   and k.display_name like 'Contato Anonimizado #%'
   and o.organization_id = k.organization_id
   and o.contact_id = k.id
   and o.created_at <= k.anonymized_at;

-- B5. O contato, POR ÚLTIMO: consentimento, dados de origem (o @, o telefone
--     em conflito, o LID), etiquetas — e o rótulo da cascata, que tira a marca
--     do botão antigo e encerra a cura deste contato.
--
--     E o TELEFONE de novo. O botão antigo o zerava, mas deixava o LID, e
--     `fn_upsert_wa_contact` casa por `wa_lid` sem olhar `is_anonymized`: se a
--     pessoa voltou a escrever por um chat @lid com o telefone junto, o
--     telefone foi regravado no anonimizado. Sem zerá-lo, `wa_identity` seguia
--     `phone:…`, o índice único impedia o contato novo, e toda mensagem futura
--     caía aqui, em claro (o gatilho da 0308 não dispara de novo).
update public.contacts set
  name = 'Cliente Anonimizado #' || substring(id::text from 1 for 8),
  display_name = 'Cliente Anonimizado #' || substring(id::text from 1 for 8),
  phone_number = null,
  consent = '{}'::jsonb,
  source_metadata = '{}'::jsonb,
  tags = '{}'::text[]
 where is_anonymized
   and name is null
   and display_name like 'Contato Anonimizado #%';

notify pgrst, 'reload schema';
