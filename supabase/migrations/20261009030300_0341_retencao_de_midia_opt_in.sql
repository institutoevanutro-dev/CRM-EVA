-- Migration 0341 — a retenção de mídia passa a existir, como OPT-IN por organização.
-- Porte de melgarafael/DeskcommCRM #1731 (256f66fa6e, upstream 0432), #2180
-- (1229e94315, upstream 0557) e #2309 (15f5b9dcda, upstream 0572), num arquivo
-- só: o corpo abaixo é a última definição do original (a união das três), com
-- duas diferenças deliberadas:
--   * `media_retention_enforced` nasce FALSE (lá, TRUE). Neste fork a limpeza
--     nunca rodou, e nada pode sumir depois da atualização sem alguém ligar.
--   * os passos de ÓRFÃO (2 e 2b) também obedecem ao interruptor (lá, não).
-- Os números 0342 e 0343, reservados para a 0557 e a 0572, não são usados:
-- empilhar três corpos da mesma função no apêndice do baseline só faria o
-- `update.sh` recriá-la três vezes.
--
-- Por que existe: `organizations.media_retention_days` é prometida pelo
-- formulário e nada a cumpria. O bucket só cresce, e a cota do Storage do
-- Supabase gratuito é 1 GB, dividida com o resto (no original, uma instalação
-- passou disso e o projeto inteiro respondeu 402).
--
-- Idempotente: `add column if not exists`, `create or replace`.

-- Interruptor da limpeza automática de mídia antiga, por organização. OPT-IN:
-- nasce DESLIGADO para quem já existe e para quem for criado (diferença
-- deliberada em relação ao original, onde o padrão é ligado). Ninguém perde
-- arquivo depois da atualização; a limpeza só roda para quem ligar em
-- Configurações › Organização. Sem `update` de backfill: o `update.sh` reaplica
-- este bloco a cada versão e desfaria a escolha de quem mexeu no interruptor.
alter table public.organizations
  add column if not exists media_retention_enforced boolean not null default false;

-- A retenção de mídia EXECUTADA. A função não apaga arquivo: ela ENFILEIRA em
-- `storage_redaction_queue` (a mesma fila da anonimização LGPD), e o cron
-- `storage-redaction` remove pelo Storage API. Chamada em tandas pelo cron
-- `app/api/v1/cron/media-retention` (diário). Só o service_role executa.
--
-- Passos, todos só para organização com o interruptor LIGADO:
--   0. expurgo das linhas `deleted` da própria retenção com mais de 90 dias;
--   1. mensagem mais velha que `media_retention_days` (piso de 30 dias no
--      corpo): o arquivo vai para a fila se nenhuma outra mensagem o usa, e a
--      mensagem perde `media_storage_path`, `media_url` e a transcrição, e ganha
--      `metadata.media_status='expired'` (o aviso "Mídia apagada" da tela).
--      Pausada enquanto a organização tem pedido LGPD em andamento;
--   2. órfão de `whatsapp-media` (pastas `org/<conversa>/` e `org/avatars/`,
--      nunca `org/templates/`), com um dia de carência;
--   2b. órfão de `internal-media` (anexo de nota apagada);
--   2c. anexo de nota interna viva mais velho que a retenção (mesmo knob, mesma
--      pausa LGPD).

create or replace function public.fn_enfileirar_midia_vencida(p_limite integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  v_lim integer := greatest(1, least(coalesce(p_limite, 500), 5000));
  v_vencidas integer := 0;
  v_orfas integer := 0;
  -- Órfãos do bucket PRÓPRIO da nota interna (0483). Contam em `v_orfas`:
  -- é a mesma categoria — arquivo sem ponteiro — e a chave de retorno não
  -- muda (o `toEqual` congelado de `poda-de-midia.test.ts` mede as três).
  v_orfas_nota integer := 0;
  -- Anexo de nota VIVO que já passou da retenção (#1887). Conta em
  -- `v_vencidas`: é a MESMA categoria — arquivo vencido por idade — e a chave
  -- congelada do retorno (0435) não muda de nome nem de número.
  v_vencidas_nota integer := 0;
  -- O que o expurgo apagou NESTA chamada (#1765). Começa em 0 para que a
  -- rodada sem nada a expurgar devolva 0 — e não null, que o cron somaria
  -- como se fosse apagado.
  v_expurgadas integer := 0;
  -- Janela do expurgo, em UM lugar só: é a constante que se muda amanhã.
  v_janela_deleted interval := interval '90 days';
begin
  -- 0. EXPURGO: a linha `deleted` da RETENÇÃO já cumpriu o papel (o arquivo
  --    saiu do bucket) e nada mais precisa dela — sem isto a fila cresce sem
  --    teto (#1739, item 2). Só `deleted`: `skipped` é «o objeto já não
  --    existe», `failed` é a prova de uma remoção que nunca passou das 3
  --    tentativas, e a issue manda não mexer em nenhuma das duas.
  --    E só a de retenção (`request_id is null`): a linha de pedido LGPD é o
  --    ÚNICO registro por objeto de que a mídia do titular saiu do bucket — o
  --    worker só troca o `status` e nada audita a remoção física. Ela sai
  --    sozinha se o pedido for apagado (FK `on delete set null`).
  --    O `GET DIAGNOSTICS` conta o que o DELETE apagou NESTA chamada (#1765):
  --    sem ele a rodada que só expurgou é indistinguível, na trilha, da rodada
  --    que não tinha o que fazer.
  delete from public.storage_redaction_queue
   where status = 'deleted'
     and request_id is null
     and coalesce(processed_at, enqueued_at) < now() - v_janela_deleted;
  get diagnostics v_expurgadas = row_count;

  -- 1. VENCIDAS: arquivo de mensagem mais velho que a retenção da organização —
  --    SÓ de organização com o interruptor LIGADO (`media_retention_enforced`,
  --    0557/#1534) e que NÃO está com pedido LGPD em andamento: um pedido de
  --    acesso/eliminação em curso (`lgpd_requests` em `received`/`processing`)
  --    não pode ter o objeto destruído no meio do atendimento — a suspensão é
  --    da ORGANIZAÇÃO INTEIRA, o lado conservador de um prazo legal. O índice
  --    `lgpd_requests_org_status_idx` (organization_id, status) cobre a
  --    anti-join. A mensagem fica (texto, status, horário); o arquivo sai, a
  --    `media_url` também (a rota não busca de novo do provedor), a transcrição
  --    some junto (`media_derived_text`) e a tela mostra o aviso via
  --    `metadata.media_status='expired'`. O piso de 30 dias é o mesmo do
  --    formulário, mesmo com valor menor gravado no banco.
  with alvo as (
    select m.id, m.organization_id, m.media_storage_path as caminho,
           greatest(coalesce(o.media_retention_days, 365), 30) as retencao_dias
      from public.messages m
      join public.organizations o on o.id = m.organization_id
     where m.media_storage_path is not null
       and o.media_retention_enforced
       and m.created_at < now() - make_interval(days => greatest(coalesce(o.media_retention_days, 365), 30))
       and not exists (
         select 1 from public.lgpd_requests r
          where r.organization_id = m.organization_id
            and r.status in ('received', 'processing')
       )
     order by m.created_at
     limit v_lim
     for update of m skip locked
  ), fila as (
    -- O arquivo só vai para a fila quando nenhuma OUTRA mensagem o usa: a foto
    -- de catálogo tem caminho fixo por conversa e é reaproveitada a cada
    -- reenvio (no original, `fotos-do-produto.ts`), então a mensagem de ontem pode apontar
    -- para o mesmo arquivo da vencida. A vencida perde o caminho do mesmo
    -- jeito; o arquivo sai quando a última referência vencer (aqui) ou no
    -- passo 2, como órfão.
    --
    -- O `do update` é o conserto do #1739: se aquele caminho já saiu da fila
    -- (`deleted`) ou o objeto já nem existia (`skipped`), um arquivo NOVO pode
    -- estar gravado ali agora — e o `do nothing` da 0432 engolia este pedido
    -- silenciosamente, deixando o arquivo novo fora da retenção PARA SEMPRE.
    -- O `where` é a outra metade do conserto: `pending`/`failed` em curso não
    -- são interrompidos (uma remoção em andamento não perde a tentativa).
    insert into public.storage_redaction_queue (organization_id, bucket, object_path)
    select distinct a.organization_id, 'whatsapp-media', a.caminho
      from alvo a
     where not exists (
       select 1 from public.messages m2
        where m2.media_storage_path = a.caminho
          and m2.id not in (select id from alvo)
     )
    on conflict (bucket, object_path) do update
      set status = 'pending',
          attempts = 0,
          enqueued_at = now(),
          processed_at = null,
          error_message = null
      where storage_redaction_queue.status in ('deleted', 'skipped')
    returning 1
  ), limpas as (
    update public.messages m
       set media_storage_path = null,
           media_url = null,
           media_derived_text = null,
           metadata = coalesce(m.metadata, '{}'::jsonb)
             || jsonb_build_object(
                  'media_status', 'expired',
                  'media_expired_at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                  'media_retention_days', alvo.retencao_dias
                ),
           updated_at = now()
      from alvo
     where m.id = alvo.id
    returning 1
  )
  select count(*) into v_vencidas from limpas;

  -- 2. ÓRFÃOS: arquivo que nada no banco aponta — o rastro de conversa apagada.
  --    Só as duas pastas que o CRM grava por mensagem e por contato:
  --    `org/<conversa>/…` e `org/avatars/…`. `org/templates/…` (cabeçalho de
  --    modelo) NUNCA entra: quem o usa guarda o link, não o caminho. Um dia de
  --    carência cobre o envio que sobe o arquivo antes de gravar a mensagem.
  with orfaos as (
    select o.name as caminho, split_part(o.name, '/', 1)::uuid as org
      from storage.objects o
     where o.bucket_id = 'whatsapp-media'
       and o.created_at < now() - interval '1 day'
       and split_part(o.name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       -- Neste fork o órfão também obedece ao interruptor (migration 0341): nada
       -- sai do bucket de uma organização que não ligou a limpeza na tela.
       and exists (
         select 1 from public.organizations g
          where g.id::text = split_part(o.name, '/', 1)
            and g.media_retention_enforced
       )
       and (
         split_part(o.name, '/', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or split_part(o.name, '/', 2) = 'avatars'
       )
       and not exists (select 1 from public.messages m where m.media_storage_path = o.name)
       and not exists (select 1 from public.contacts c where c.avatar_storage_path = o.name)
       -- Só linha EM CURSO segura o caminho (`pending`, ou `failed` que ainda
       -- é o registro de uma remoção não feita). Linha `deleted`/`skipped`
       -- NÃO bloqueia mais: é justamente o caso do avatar reaproveitado
       -- (#1739) — o objeto novo no caminho antigo tinha de chegar no conflito
       -- lá embaixo para ser reaberto, e este `not exists` o engolia antes.
       and not exists (
         select 1 from public.storage_redaction_queue q
          where q.bucket = 'whatsapp-media' and q.object_path = o.name
            and q.status not in ('deleted', 'skipped')
       )
     limit v_lim
  ), fila as (
    insert into public.storage_redaction_queue (organization_id, bucket, object_path)
    select org, 'whatsapp-media', caminho from orfaos
    on conflict (bucket, object_path) do update
      set status = 'pending',
          attempts = 0,
          enqueued_at = now(),
          processed_at = null,
          error_message = null
      where storage_redaction_queue.status in ('deleted', 'skipped')
    returning 1
  )
  select count(*) into v_orfas from fila;


  -- 2b. ÓRFÃOS DA NOTA INTERNA (migration 0483): o passo 2 varre SÓ o bucket
  --     `whatsapp-media` (filtro `bucket_id`), então um anexo de nota nunca
  --     entraria na conta — e a nota que o atendente apagou deixaria o arquivo
  --     para sempre no `internal-media`, custo que só cresce. Mesmo desenho do
  --     passo 2, com as duas pontas certas: bucket `internal-media` e
  --     `conversation_notes.media_storage_path` como a referência que segura o
  --     caminho. Um dia de carência cobre o upload que sobe ANTES de a nota ser
  --     gravada (é a ordem do composer), como o passo 2 cobre o envio.
  --     Uma linha `pending`/`failed` em curso segura o caminho; `deleted`/
  --     `skipped` não, pelo mesmo motivo escrito no passo 2 (caminho reuso).
  with orfaos_da_nota as (
    select o.name as caminho, split_part(o.name, '/', 1)::uuid as org
      from storage.objects o
     where o.bucket_id = 'internal-media'
       and o.created_at < now() - interval '1 day'
       and split_part(o.name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       -- Neste fork o órfão também obedece ao interruptor (migration 0341): nada
       -- sai do bucket de uma organização que não ligou a limpeza na tela.
       and exists (
         select 1 from public.organizations g
          where g.id::text = split_part(o.name, '/', 1)
            and g.media_retention_enforced
       )
       and split_part(o.name, '/', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and not exists (
         select 1 from public.conversation_notes n where n.media_storage_path = o.name
       )
       and not exists (
         select 1 from public.storage_redaction_queue q
          where q.bucket = 'internal-media' and q.object_path = o.name
            and q.status not in ('deleted', 'skipped')
       )
     limit v_lim
  ), fila_da_nota as (
    insert into public.storage_redaction_queue (organization_id, bucket, object_path)
    select org, 'internal-media', caminho from orfaos_da_nota
    on conflict (bucket, object_path) do update
      set status = 'pending',
          attempts = 0,
          enqueued_at = now(),
          processed_at = null,
          error_message = null
      where storage_redaction_queue.status in ('deleted', 'skipped')
    returning 1
  )
  select count(*) into v_orfas_nota from fila_da_nota;
  v_orfas := v_orfas + v_orfas_nota;

  -- 2c. RETENÇÃO POR IDADE DO ANEXO DA NOTA VIVA (#1887). Até aqui o bucket
  --     `internal-media` só era alcançado quando a nota SUMIA (passo 2b) ou
  --     sob pedido LGPD (passo 6d da 0483): uma nota que CONTINUA EXISTINDO
  --     segurava o anexo para sempre, e numa cota de 1 GB dividida com
  --     `whatsapp-media` o bucket crescia sem teto — anexos de até 50 MB
  --     (issue #1887; opção A, decisão do mantenedor no PR #2309).
  --     O anexo interno passa a seguir a MESMA regra da mídia de conversa:
  --     mesmo knob (`organizations.media_retention_days`, piso de 30 dias),
  --     MESMO interruptor (`media_retention_enforced`, 0557) e MESMA pausa
  --     enquanto a organização tem pedido LGPD em andamento — sem os dois, o
  --     anexo de nota seria a ÚNICA coisa apagada numa organização que
  --     desligou a limpeza, ou no meio de um atendimento LGPD. Mesmo desenho
  --     do passo 1 — a idade é a da NOTA, a mesma
  --     medida que a da mensagem, e o arquivo só sai DEPOIS do knob. Nota
  --     viva dentro da retenção não é tocada; é esta linha que o teste de
  --     #1887 cobra (e que reprova se a condição de idade sumir).
  --     Os três ponteiros são zerados como no passo 6d da 0483: a nota fica
  --     com o texto e sem card apontando para arquivo que já saiu do bucket.
  --     Arquivo já removido à mão não quebra a rodada: a linha entra como
  --     `pending` e o worker a fecha como `skipped`, como no passo 1.
  --     Aqui não existe o "nenhuma OUTRA mensagem usa" do passo 1: o caminho
  --     de anexo é único por upload (`note-<uuid>.<ext>`). A rota de nota só
  --     confere que o caminho é da mesma conversa, então duas notas PODEM
  --     apontar para o mesmo arquivo por chamada direta à API (pela tela não
  --     acontece); nesse caso a mais nova perde o anexo quando a mais velha
  --     vence — caso raro, aceito na decisão.
  with vencidas_da_nota as (
    select n.id, n.organization_id, n.media_storage_path as caminho
      from public.conversation_notes n
      join public.organizations o on o.id = n.organization_id
     where n.media_storage_path is not null
       and o.media_retention_enforced
       and n.created_at < now() - make_interval(days => greatest(coalesce(o.media_retention_days, 365), 30))
       and not exists (
         select 1 from public.lgpd_requests r
          where r.organization_id = n.organization_id
            and r.status in ('received', 'processing')
       )
     order by n.created_at
     limit v_lim
     for update of n skip locked
  ), fila_da_retencao as (
    insert into public.storage_redaction_queue (organization_id, bucket, object_path)
    select distinct v.organization_id, 'internal-media', v.caminho
      from vencidas_da_nota v
    on conflict (bucket, object_path) do update
      set status = 'pending',
          attempts = 0,
          enqueued_at = now(),
          processed_at = null,
          error_message = null
      where storage_redaction_queue.status in ('deleted', 'skipped')
    returning 1
  ), limpas_da_nota as (
    update public.conversation_notes n
       set media_storage_path = null, media_mime = null, media_size_bytes = null
      from vencidas_da_nota v
     where n.id = v.id
    returning 1
  )
  select count(*) into v_vencidas_nota from limpas_da_nota;
  v_vencidas := v_vencidas + v_vencidas_nota;
  return jsonb_build_object('vencidas', v_vencidas, 'orfas', v_orfas, 'expurgadas', v_expurgadas);
end;
$$;

revoke execute on function public.fn_enfileirar_midia_vencida(integer) from public, anon, authenticated;
grant execute on function public.fn_enfileirar_midia_vencida(integer) to service_role;
