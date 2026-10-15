-- ============================================================================
-- 0362 — ETIQUETA DE CIDADE PELO ENDEREÇO: a cidade do endereço estruturado
-- vira a etiqueta "cidade: X" do contato, sozinha.
--
-- ─── O problema
--
-- A clínica filtra e segmenta por etiquetas "cidade: Vitória", "cidade: Serra",
-- "cidade: Vila Velha" e "cidade: Cariacica" (vocabulário em
-- `organizations.settings.tags`). Quem as punha era a IA (`crm_manage_tags`,
-- em caixa baixa) ou alguém da equipe, à mão. O endereço estruturado
-- (`contacts.custom_fields.endereco_estruturado.cidade`, gravado pelo
-- prontuário: `fn_prontuario_create_contact_v2` / `_patch_contact_v2`) já diz
-- a cidade, e a etiqueta era uma segunda fonte da mesma informação.
--
-- ─── A regra (DIRC: CALCULAR, não duplicar)
--
-- A etiqueta é derivada do endereço no INSTANTE em que a cidade do endereço
-- muda — em qualquer caminho de escrita, porque mora num BEFORE trigger de
-- `contacts`:
--
--   - a cidade normalizada (sem acento, caixa, espaços repetidos) é procurada
--     nas entradas "cidade: X" do vocabulário da PRÓPRIA organização
--     (`settings.tags`, string ou objeto, e `settings.canonical_conversation_tags`).
--     Achou: a etiqueta é a entrada em caixa baixa ("cidade: vitória"), a
--     mesma grafia que a IA grava — nunca duas grafias. Não achou: nenhuma
--     etiqueta nova (não se inventa etiqueta fora do vocabulário);
--   - o endereço passa a mandar: toda etiqueta "cidade: …" de OUTRA cidade sai,
--     inclusive a posta pela IA ou à mão (conflito: o endereço vence). A troca
--     fica escrita na linha do tempo de cada negócio do contato
--     (`crm_lead_activities`, tipo `contact_city_tag_changed`, ator `system`);
--   - cidade apagada: sai a etiqueta da cidade que estava no endereço;
--   - sem cidade no endereço, nada é tocado: a etiqueta posta pela IA ou à mão
--     fica. O endereço só é a fonte quando existe.
--
-- O trigger só age quando a cidade MUDA. Entre uma mudança e outra a equipe
-- manda: quem tira a etiqueta à mão não a vê voltar enquanto a cidade do
-- endereço for a mesma. É por isso que não há coluna de dono como a
-- `client_tag_by_system` da 0262: lá a etiqueta tem vida própria; aqui ela é
-- projeção do endereço, recalculada só quando o endereço muda.
--
-- Organização SEM nenhuma entrada "cidade: …" no vocabulário: nada acontece.
-- O vocabulário é o interruptor; outra instalação não tem etiqueta reescrita.
--
-- Anonimizado e mesclado: nunca tocados (a WHEN do trigger os exclui).
--
-- ─── Por que trigger
--
-- Os escritores de `endereco_estruturado` são funções SQL (as duas RPCs do
-- prontuário) e o PATCH genérico de `custom_fields` (rota de contatos, que
-- substitui o objeto inteiro). Regra no chamador o próximo chamador não herda.
-- BEFORE, e não AFTER: a etiqueta entra NA MESMA escrita. Um UPDATE posterior
-- mexeria em `updated_at` depois do `returning` da RPC do prontuário, e o
-- `last_crm_updated_at` do vínculo ficaria velho — a próxima revisão do
-- prontuário cairia em `prontuario_revision_conflict`. Trigger nunca faz HTTP.
--
-- ─── Sem evento, de propósito
--
-- `contact.tag_added` dispara automação ("quando ganhar etiqueta" → WhatsApp).
-- A clínica vai receber ~180 endereços de uma vez pelo prontuário; um evento
-- por contato seria um disparo em massa que ninguém pediu. O rastro é a
-- própria etiqueta, a linha do tempo e a auditoria da rota do prontuário.
--
-- ─── Backfill
--
-- Contatos que JÁ têm cidade no endereço recebem a etiqueta uma vez, aqui (e
-- no apêndice do baseline, só na primeira aplicação: reaplicar a cada deploy
-- desfaria a remoção à mão). Sem linha do tempo e sem evento.
--
-- Idempotente: `create or replace`, e o backfill só escreve onde muda algo.
-- ============================================================================

create or replace function public.fn_normalizar_cidade(p_cidade text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(lower(btrim(regexp_replace(
    translate(coalesce(p_cidade, ''),
      'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑáàâãäéèêëíìîïóòôõöúùûüçñ',
      'AAAAAEEEEIIIIOOOOOUUUUCNaaaaaeeeeiiiiooooouuuucn'),
    '\s+', ' ', 'g'))), '')
$$;

comment on function public.fn_normalizar_cidade(text) is
  'Cidade para comparar: sem acento, caixa baixa, espaços colapsados; vazio vira null (migration 0362).';

revoke execute on function public.fn_normalizar_cidade(text) from public, anon, authenticated;

-- A conta inteira, PURA: recebe as etiquetas, a cidade antes e depois e o
-- `settings` da organização, devolve as etiquetas novas. É o que os testes
-- exercitam direto, sem montar contato.
create or replace function public.fn_etiquetas_com_cidade_do_endereco(
  p_tags text[], p_cidade_antes text, p_cidade text, p_settings jsonb
)
returns text[]
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_cidade text := public.fn_normalizar_cidade(p_cidade);
  v_antes text := public.fn_normalizar_cidade(p_cidade_antes);
  v_tags text[] := coalesce(p_tags, '{}'::text[]);
  v_vocab text[];
  v_derivada text;
  v_novas text[];
begin
  select coalesce(array_agg(distinct e.tag), '{}'::text[]) into v_vocab
    from (
      select lower(btrim(coalesce(x.valor ->> 'tag', x.valor #>> '{}'))) as tag
        from jsonb_array_elements(case when jsonb_typeof(p_settings -> 'tags') = 'array'
                                       then p_settings -> 'tags' else '[]'::jsonb end) x(valor)
      union all
      select lower(btrim(x.valor #>> '{}'))
        from jsonb_array_elements(case when jsonb_typeof(p_settings -> 'canonical_conversation_tags') = 'array'
                                       then p_settings -> 'canonical_conversation_tags' else '[]'::jsonb end) x(valor)
    ) e
   where e.tag like 'cidade:%'
     and public.fn_normalizar_cidade(substr(e.tag, 8)) is not null;

  -- Sem "cidade: …" no vocabulário, a organização não usa a regra.
  if cardinality(v_vocab) = 0 then
    return v_tags;
  end if;

  if v_cidade is null then
    -- Cidade apagada: sai só a etiqueta da cidade que estava no endereço.
    if v_antes is null then
      return v_tags;
    end if;
    select coalesce(array_agg(t order by o), '{}'::text[]) into v_novas
      from unnest(v_tags) with ordinality u(t, o)
     where not (lower(btrim(t)) like 'cidade:%'
                and public.fn_normalizar_cidade(substr(lower(btrim(t)), 8)) = v_antes);
    return v_novas;
  end if;

  select min(v) into v_derivada
    from unnest(v_vocab) v
   where public.fn_normalizar_cidade(substr(v, 8)) = v_cidade;

  -- O endereço manda: fica a etiqueta que não é de cidade, a derivada, e — se a
  -- cidade não está no vocabulário — a que já nomeia a mesma cidade.
  select coalesce(array_agg(t order by o), '{}'::text[]) into v_novas
    from (select t, min(o) as o
            from unnest(v_tags) with ordinality u(t, o)
           where lower(btrim(t)) not like 'cidade:%'
              or t = v_derivada
              or (v_derivada is null
                  and public.fn_normalizar_cidade(substr(lower(btrim(t)), 8)) = v_cidade)
           group by t) k;

  if v_derivada is not null and not (v_derivada = any(v_novas)) then
    v_novas := array_append(v_novas, v_derivada);
  end if;
  return v_novas;
end $$;

comment on function public.fn_etiquetas_com_cidade_do_endereco(text[], text, text, jsonb) is
  'Etiquetas do contato depois de a cidade do endereço estruturado mudar de p_cidade_antes para p_cidade '
  '(migration 0362). A etiqueta "cidade: x" vem do vocabulário da organização (p_settings), em caixa baixa; '
  'outra etiqueta de cidade sai; cidade apagada tira só a da cidade anterior; sem vocabulário de cidade, '
  'nada muda. Provado em tests/invariants/etiqueta-de-cidade-pelo-endereco.test.ts.';

revoke execute on function public.fn_etiquetas_com_cidade_do_endereco(text[], text, text, jsonb) from public, anon, authenticated;

-- SECURITY DEFINER pela linha do tempo: a escrita pode vir de uma sessão cuja
-- policy de `crm_lead_activities` não alcança todos os negócios do contato, e o
-- registro do sistema não pode depender de quem editou.
create or replace function public.fn_contato_etiqueta_de_cidade()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_antes text;
  v_cidade text := new.custom_fields -> 'endereco_estruturado' ->> 'cidade';
  v_settings jsonb;
  v_novas text[];
  v_postas text[];
  v_tiradas text[];
begin
  if tg_op = 'UPDATE' then
    v_antes := old.custom_fields -> 'endereco_estruturado' ->> 'cidade';
    -- "Vitoria" → "Vitória" é a mesma cidade: não reescreve etiqueta.
    if public.fn_normalizar_cidade(v_antes) is not distinct from public.fn_normalizar_cidade(v_cidade) then
      return new;
    end if;
  end if;

  select o.settings into v_settings from public.organizations o where o.id = new.organization_id;
  v_novas := public.fn_etiquetas_com_cidade_do_endereco(new.tags, v_antes, v_cidade, v_settings);
  if v_novas is not distinct from coalesce(new.tags, '{}'::text[]) then
    return new;
  end if;

  v_postas := array(select unnest(v_novas) except select unnest(coalesce(new.tags, '{}'::text[])));
  v_tiradas := array(select unnest(coalesce(new.tags, '{}'::text[])) except select unnest(v_novas));
  new.tags := v_novas;

  -- Linha do tempo de cada negócio do contato (`lead_id` é NOT NULL: contato
  -- sem negócio não tem onde escrever). No INSERT ainda não há negócio.
  if tg_op = 'UPDATE' then
    insert into public.crm_lead_activities
      (organization_id, lead_id, contact_id, source_module, source_id, type,
       actor_kind, reason, payload, performed_by_user_id)
    select new.organization_id, l.id, new.id, 'crm', new.id, 'contact_city_tag_changed',
           'system',
           'Cidade do endereço: ' || coalesce(nullif(btrim(v_cidade), ''), 'apagada')
             || case when cardinality(v_postas) > 0
                     then '. Etiqueta posta: ' || array_to_string(v_postas, ', ') else '' end
             || case when cardinality(v_tiradas) > 0
                     then '. Etiqueta tirada: ' || array_to_string(v_tiradas, ', ') else '' end,
           jsonb_build_object('cidade', v_cidade, 'cidade_antes', v_antes,
                              'postas', to_jsonb(v_postas), 'tiradas', to_jsonb(v_tiradas)),
           auth.uid()
      from public.crm_leads l
     where l.organization_id = new.organization_id
       and l.contact_id = new.id;
  end if;

  return new;
end $$;

comment on function public.fn_contato_etiqueta_de_cidade() is
  'BEFORE INSERT/UPDATE de contacts (migration 0362): quando a cidade de custom_fields.endereco_estruturado '
  'muda, as etiquetas "cidade: x" passam a seguir o endereço (fn_etiquetas_com_cidade_do_endereco), na '
  'mesma escrita, com linha do tempo contact_city_tag_changed em cada negócio. Sem evento: não dispara '
  'automação. Anonimizado e mesclado ficam de fora pela WHEN.';

revoke execute on function public.fn_contato_etiqueta_de_cidade() from public, anon, authenticated;

-- Backfill: quem já tem cidade no endereço. Sem linha do tempo, sem evento.
update public.contacts c
   set tags = public.fn_etiquetas_com_cidade_do_endereco(
                c.tags, null, c.custom_fields -> 'endereco_estruturado' ->> 'cidade', o.settings)
  from public.organizations o
 where o.id = c.organization_id
   and c.is_anonymized = false
   and c.is_merged_into is null
   and public.fn_normalizar_cidade(c.custom_fields -> 'endereco_estruturado' ->> 'cidade') is not null
   and public.fn_etiquetas_com_cidade_do_endereco(
         c.tags, null, c.custom_fields -> 'endereco_estruturado' ->> 'cidade', o.settings)
       is distinct from coalesce(c.tags, '{}'::text[]);

-- A WHEN compara VALORES: o caso comum (cidade igual) nem chama a função.
create or replace trigger trg_contato_etiqueta_de_cidade_update
  before update on public.contacts
  for each row
  when ((old.custom_fields -> 'endereco_estruturado' ->> 'cidade')
          is distinct from (new.custom_fields -> 'endereco_estruturado' ->> 'cidade')
    and new.is_anonymized = false
    and new.is_merged_into is null)
  execute function public.fn_contato_etiqueta_de_cidade();

create or replace trigger trg_contato_etiqueta_de_cidade_insert
  before insert on public.contacts
  for each row
  when ((new.custom_fields -> 'endereco_estruturado' ->> 'cidade') is not null
    and coalesce(new.is_anonymized, false) = false
    and new.is_merged_into is null)
  execute function public.fn_contato_etiqueta_de_cidade();
