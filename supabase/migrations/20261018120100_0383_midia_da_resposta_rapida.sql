-- ============================================================================
-- 0383 — A RESPOSTA RÁPIDA LEVA IMAGEM DO PRÓPRIO OPERADOR
-- Portado do projeto original (DeskcommCRM, PR #2704 de @webtecnica; 0643 lá),
-- com a guarda de caminho deste fork (mesmo desenho da 0382).
--
-- ─── A coluna ────────────────────────────────────────────────────────────────
--
-- `message_templates.midias jsonb` guarda a DESCRIÇÃO das imagens do template
-- (`storage_path`, `media_mime`, `media_size_bytes` — os mesmos `media_*` de
-- `messages` que o envio de mídia consome). Os BYTES moram no bucket PRIVADO
-- `whatsapp-media`, no prefixo `{org}/templates/{template}/{uuid}.(jpg|png)`,
-- gerado pela rota `POST /api/v1/message-templates/:id/midias` (service role),
-- nunca aceito do cliente. Quem lê é a rota `GET .../midias/:indice`, que
-- confere o caminho e devolve os bytes pela própria origem (sem URL pública).
-- Uma coluna e não uma tabela de filhas: a lista é lida e reescrita inteira.
-- O default `[]` cobre as linhas atuais — template só de texto sai como antes.
-- Teto de 5 imagens também no banco (`message_templates_midias_maxima`).
--
-- ─── A guarda de caminho (o que este fork acrescenta) ──────────────────────
--
-- A coluna é gravável pelo PostgREST com a sessão (RLS `message_templates_write`)
-- e o arquivo é aberto por service role, SEM RLS. Sem guarda, uma sessão
-- gravaria em `midias` o caminho de um arquivo de OUTRA organização e a rota de
-- leitura o serviria (ou a remoção o apagaria). As rotas já conferem
-- (`midiaPertenceAoTemplate`), e o banco segura a mesma régua para quem fala
-- direto com o PostgREST: na escrita COM SESSÃO, todo `storage_path` de
-- `midias` tem de ser `{org}/templates/{id}/{uuid}.(jpg|png)` da PRÓPRIA linha
-- (42501 `midia_do_template_fora_do_template`). Service role, motor e
-- migrations passam — a mesma régua da `fn_midia_da_mensagem_e_da_conversa`
-- (0382). Nenhum dado existente é tocado (a coluna nasce vazia).
--
-- O expurgo de órfãos de `whatsapp-media` (`fn_enfileirar_midia_vencida`) já
-- não alcança `{org}/templates/` — nada a mudar ali.
--
-- Idempotente: `add column if not exists`, constraint criada só quando falta,
-- `create or replace` na função e nos gatilhos.
-- ============================================================================

alter table public.message_templates
  add column if not exists midias jsonb not null default '[]';

-- Só cria quando falta: reaplicar (`update.sh`) não derruba a constraint nem
-- por um comando (`reaplicar-o-baseline-nao-abre-janela.test.ts`). Sem `case`
-- de propósito: o `pg_get_constraintdef` o quebra em linhas e cega a varredura
-- de vocabulário. Um não-array é recusado do mesmo jeito (violação ou erro).
do $janela$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'message_templates_midias_maxima'
                    and conrelid = 'public.message_templates'::regclass) then
    alter table public.message_templates
      add constraint message_templates_midias_maxima
      check (jsonb_typeof(midias) = 'array' and jsonb_array_length(midias) <= 5);
  end if;
end $janela$;

create or replace function public.fn_midia_do_template_e_do_template()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_prefixo text := new.organization_id::text || '/templates/' || new.id::text || '/';
  v_item jsonb;
  v_caminho text;
begin
  if auth.uid() is null and current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  -- Não-array: quem recusa é o CHECK `message_templates_midias_maxima`.
  if jsonb_typeof(new.midias) is distinct from 'array' then
    return new;
  end if;
  for v_item in select * from jsonb_array_elements(new.midias) loop
    v_caminho := case when jsonb_typeof(v_item) = 'object' then v_item ->> 'storage_path' end;
    if v_caminho is null
       or left(v_caminho, length(v_prefixo)) is distinct from v_prefixo
       or substr(v_caminho, length(v_prefixo) + 1)
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$' then
      raise exception 'midia_do_template_fora_do_template' using errcode = '42501';
    end if;
  end loop;
  return new;
end $$;

comment on function public.fn_midia_do_template_e_do_template() is
  'Guarda de message_templates (migration 0383): na escrita com sessão, todo storage_path de midias é '
  '{org}/templates/{id}/{uuid}.(jpg|png) da própria linha; 42501 midia_do_template_fora_do_template. Service role, '
  'motor e migrations passam. Provado em tests/invariants/midia-da-resposta-rapida.test.ts.';

revoke execute on function public.fn_midia_do_template_e_do_template() from public, anon, authenticated;

create or replace trigger trg_midia_do_template_insert
  before insert on public.message_templates
  for each row
  when (new.midias is distinct from '[]'::jsonb)
  execute function public.fn_midia_do_template_e_do_template();

create or replace trigger trg_midia_do_template_update
  before update on public.message_templates
  for each row
  when (new.midias is distinct from '[]'::jsonb
        and (old.midias is distinct from new.midias
             or old.organization_id is distinct from new.organization_id
             or old.id is distinct from new.id))
  execute function public.fn_midia_do_template_e_do_template();

notify pgrst, 'reload schema';
