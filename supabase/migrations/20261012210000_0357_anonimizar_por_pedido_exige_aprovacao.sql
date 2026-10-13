-- 0357: anonimizar por pedido exige aprovação provada na linha do pedido.
--
-- O bloco abaixo é o MESMO, letra a letra, do apêndice de `supabase/baseline.sql`:
-- é ele que o deploy reaplica a cada atualização.

-- ---- anonimizar por pedido exige aprovação provada (migration 0357) ----
--
-- O defeito: o `lgpd-redact-worker` anonimizava ao receber o evento
-- `lgpd.redact_received`, sem conferir que alguém tinha aprovado o pedido. O
-- evento era a autorização. O webhook da loja (Nuvemshop) emitia ao CRIAR o
-- pedido, então o "apagar cliente" da loja anonimizava sem nenhum humano; e
-- qualquer outro emissor do servidor (uma automação, um evento reprocessado, uma
-- função futura) fazia o mesmo com um pedido registrado à mão. A aprovação, por
-- sua vez, não ficava em lugar nenhum da linha do pedido: só virava `processing`.
-- Anonimização não tem volta.
--
-- O que muda:
--
-- 1. A aprovação passa a ser gravada na linha do pedido, em
--    `request_payload.approval`: `request_id`, `organization_id`, `contact_id`
--    (os três do pedido, no momento da aprovação), `approved_by`, `approved_at`
--    e `approved_reason`. Quem grava é a rota de aprovação, que exige
--    administrador. Nenhuma coluna nova: `request_payload` já é onde o pedido
--    guarda o que não é da auditoria, só administrador escreve em
--    `lgpd_requests` (RLS), e os webhooks gravam ali uma projeção de chaves
--    fixas, sem `approval`.
--
-- 2. `fn_lgpd_recusa_do_redact(org, pedido, contato)` é a REGRA, uma só, lida
--    pelo worker antes de qualquer gravação e pela cascata dentro da transação
--    do irreversível. Devolve NULL quando o pedido prova a aprovação, ou o
--    motivo da recusa. Ela lê a linha do pedido, nunca o evento. Exige: pedido
--    desta organização, do tipo `redact`/`store_redact`; aprovação para ESTE
--    pedido, ESTA organização e o contato que o pedido tinha; justificativa de
--    10 caracteres ou mais; data; e aprovador que seja administrador desta
--    organização (ou administrador da plataforma) com o acesso vigente. Com
--    `p_contact_id`, confere também que o contato é o do pedido (ou um cadastro
--    unido a ele). Pedido de contato sem `contact_id` (cliente da loja que o
--    worker resolve pelo id externo) e pedido da organização inteira não
--    prendem contato.
--
-- 3. `fn_lgpd_cascade_redact_contact` consulta a regra antes de tudo quando
--    recebe um pedido que EXISTE, e recusa com 42501
--    `lgpd_redact_not_approved: <motivo>`. Sem pedido (`p_request_id` nulo: o
--    botão da ficha, que tem o portão dele em `fn_lgpd_anonymize_contact`, e a
--    cura da 0317) nada muda. É o único trecho novo no corpo: nenhum passo da
--    redação muda de alcance.
--
-- Reaplicável: só `create or replace` e privilégio trocado num comando só.

create or replace function public.fn_lgpd_recusa_do_redact(p_organization_id uuid, p_request_id uuid, p_contact_id uuid)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_pedido public.lgpd_requests%rowtype;
  v_aprovacao jsonb;
  v_quem uuid;
begin
  select * into v_pedido
    from public.lgpd_requests
   where id = p_request_id and organization_id = p_organization_id;
  if not found then
    return 'request_not_found';
  end if;
  if v_pedido.request_type not in ('redact', 'store_redact') then
    return 'wrong_request_type';
  end if;

  v_aprovacao := v_pedido.request_payload -> 'approval';
  if v_aprovacao is null or jsonb_typeof(v_aprovacao) <> 'object' then
    return 'not_approved';
  end if;
  if (v_aprovacao ->> 'request_id') is distinct from v_pedido.id::text then
    return 'approval_for_another_request';
  end if;
  if (v_aprovacao ->> 'organization_id') is distinct from v_pedido.organization_id::text then
    return 'approval_for_another_organization';
  end if;
  if (v_aprovacao ->> 'contact_id') is distinct from v_pedido.contact_id::text then
    return 'approval_for_another_contact';
  end if;
  if char_length(btrim(coalesce(v_aprovacao ->> 'approved_reason', ''))) < 10 then
    return 'approval_without_reason';
  end if;
  if coalesce(v_aprovacao ->> 'approved_at', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}' then
    return 'approval_without_timestamp';
  end if;
  if coalesce(v_aprovacao ->> 'approved_by', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return 'approval_without_approver';
  end if;
  v_quem := (v_aprovacao ->> 'approved_by')::uuid;
  if not exists (select 1 from public.user_organizations
                  where user_id = v_quem and organization_id = p_organization_id
                    and role = 'admin' and revoked_at is null)
     and not exists (select 1 from public.platform_admins
                      where user_id = v_quem and revoked_at is null) then
    return 'approver_not_admin';
  end if;

  if p_contact_id is not null
     and v_pedido.scope = 'contact'
     and v_pedido.contact_id is not null
     and p_contact_id <> v_pedido.contact_id
     and not exists (select 1 from public.contacts
                      where id = p_contact_id and organization_id = p_organization_id
                        and is_merged_into = v_pedido.contact_id) then
    return 'contact_outside_request';
  end if;

  return null;
end;
$$;

do $janela$ begin
  revoke all on function public.fn_lgpd_recusa_do_redact(uuid,uuid,uuid) from public, anon, authenticated;
  grant execute on function public.fn_lgpd_recusa_do_redact(uuid,uuid,uuid) to service_role;
end $janela$;

create or replace function public.fn_lgpd_cascade_redact_contact(p_organization_id uuid, p_contact_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_already bool;
  v_counts jsonb := '{}'::jsonb;
  v_media_paths text[] := '{}';
  v_anon_label text;
  v_count int;
  v_igsids text[] := '{}';
  v_lapide uuid;
  v_recusa text;
begin
  -- PORTÃO (migration 0357): um pedido que EXISTE só anonimiza se a linha dele
  -- provar a aprovação. A regra é `fn_lgpd_recusa_do_redact`, a mesma que o
  -- worker consulta antes de gravar qualquer coisa; aqui ela roda na transação
  -- do irreversível. `p_request_id` nulo é o botão da ficha, que tem o portão
  -- dele (`fn_lgpd_anonymize_contact`).
  if p_request_id is not null
     and exists (select 1 from lgpd_requests where id = p_request_id) then
    v_recusa := public.fn_lgpd_recusa_do_redact(p_organization_id, p_request_id, p_contact_id);
    if v_recusa is not null then
      raise exception 'lgpd_redact_not_approved: %', v_recusa using errcode = '42501';
    end if;
  end if;
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

  -- 0c. CADASTROS UNIDOS A ESTE (migration 0317, revisão) — a lápide de uma
  --     fusão é a MESMA pessoa. `fn_mesclar_contatos` só marca `is_merged_into`
  --     nela: nome, e-mail, telefone, origem (@, LID), etiquetas e foto ficam na
  --     linha, e a conversa que colidiu com a do principal FICA nela. Cada
  --     lápide recebe a cascata inteira, com a auditoria dela — um passo
  --     escrito à mão aqui divergiria do que a cascata faz. A fusão achata a
  --     cadeia (quem apontava para o secundário passa a apontar para o
  --     vencedor), então um nível basta; a recursão cobre o resto.
  v_count := 0;
  for v_lapide in
    select id from contacts
     where organization_id = p_organization_id
       and is_merged_into = p_contact_id
       and not is_anonymized
     order by id
  loop
    perform public.fn_lgpd_cascade_redact_contact(p_organization_id, v_lapide, p_request_id);
    v_count := v_count + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('contatos_unidos', v_count);

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

do $janela$ begin
  revoke all on function public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid) from public, anon, authenticated;
  grant execute on function public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid) to service_role;
end $janela$;

notify pgrst, 'reload schema';
-- end 0357
