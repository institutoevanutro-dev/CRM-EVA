-- ── As frases que abrem conversa no Direct, por organização ─────────────────
--
-- Comentário barrado pela trava por PREÇO ou AGENDAMENTO recebe uma mensagem
-- privada para começar a conversa (`lib/comentarios/gatilho-direct.ts`). O
-- texto é do dono, não nosso: mensagem automática em nome dele, indo para uma
-- pessoa prestes a comprar, não pode ser uma frase que ele nunca leu.
--
-- Mora em `organizations.settings.comentarios`. NÃO ganha tabela: são dois
-- campos de texto por organização, sem histórico, sem dono próprio e sem
-- consulta que os cruze com nada (Doutrina DIRC — não duplicar estrutura para
-- guardar duas strings).
--
-- ── Por que uma FUNÇÃO e não `.update({ settings })` ────────────────────────
--
-- `organizations.settings` já tem donos demais que leem o jsonb inteiro,
-- espalham em memória e regravam o objeto todo em round-trips separados. A
-- perda é medida e está escrita no cabeçalho de
-- `app/actions/settings/updateMarcaDaOrganizacao.ts`: `visibility_mode` volta
-- de `own` para `all` sem erro em lugar nenhum, e essa chave é lida DIRETO
-- pela RLS (`fn_can_view_conversation`, `fn_can_view_lead`). Um write de FRASE
-- revertendo, em silêncio, uma decisão de exposição de dado de cliente é
-- inaceitável. Aqui a escrita é UMA instrução, com `jsonb_set`, exatamente
-- como a 0157 fez para a marca.
--
-- Piso de papel `manager`, o mesmo de `instagram_comment_rules_write`
-- (migration 0280): quem já pode criar a regra que manda Direct por palavra
-- pode editar a frase que o gatilho manda.

create or replace function public.fn_definir_frases_de_comentario(
  p_org    uuid,
  p_actor  uuid,
  p_frases jsonb
) returns integer
    language plpgsql
    volatile
    security definer
    set search_path to 'public', 'pg_temp'
as $$
declare
  v_linhas integer;
  v_limpar boolean;
  v_chave  text;
begin
  if p_org is null or p_actor is null then
    raise exception 'frases_de_comentario_argumento_nulo'
      using errcode = '22023';
  end if;

  -- "Volte para o texto padrão" chega pelas duas formas que o transporte pode
  -- produzir, e as duas significam a mesma coisa (mesma lição da 0157: NÃO
  -- MEDIDO qual delas o PostgREST manda para um argumento jsonb nulo).
  v_limpar := p_frases is null or jsonb_typeof(p_frases) = 'null';

  if not v_limpar and jsonb_typeof(p_frases) <> 'object' then
    raise exception 'frases_de_comentario_forma_invalida: %', jsonb_typeof(p_frases)
      using errcode = '22023';
  end if;

  -- Chave desconhecida é chamada errada, não "campo novo": gravar aqui o que
  -- o leitor não lê faz o dono acreditar que editou uma frase que nunca sai.
  if not v_limpar then
    for v_chave in select jsonb_object_keys(p_frases) loop
      if v_chave not in ('preco', 'agendamento') then
        raise exception 'frases_de_comentario_chave_desconhecida: %', v_chave
          using errcode = '22023';
      end if;
      if jsonb_typeof(p_frases -> v_chave) <> 'string' then
        raise exception 'frases_de_comentario_valor_nao_texto: %', v_chave
          using errcode = '22023';
      end if;
    end loop;
  end if;

  -- Autorização: `manager` ou acima da PRÓPRIA organização, ou super-admin de
  -- plataforma. Falha ALTO (exceção): 0 já significa "a organização não
  -- existe", e colapsar os dois deixaria o chamador sem saber qual foi.
  -- Contra `user_organizations` e `p_actor`, NUNCA via `fn_role_at_least`:
  -- aquela resolve o papel por `auth.uid()`, que é NULO quando quem chama é o
  -- admin client (service_role) — e é ele que chama aqui. O gate passaria
  -- sempre. Mesmo motivo pelo qual a 0157 faz a consulta à mão.
  if not exists (
       select 1 from public.user_organizations uo
        where uo.user_id = p_actor
          and uo.organization_id = p_org
          and uo.role in ('manager', 'admin')
          and uo.revoked_at is null
     )
     and not exists (
       select 1 from public.platform_admins pa
        where pa.user_id = p_actor
          and pa.revoked_at is null
     )
  then
    raise exception 'frases_de_comentario_sem_permissao'
      using errcode = '42501';
  end if;

  update public.organizations o
     set settings = case
           when v_limpar
             then coalesce(o.settings, '{}'::jsonb) - 'comentarios'
           else jsonb_set(coalesce(o.settings, '{}'::jsonb), '{comentarios}', p_frases, true)
         end
   where o.id = p_org;

  get diagnostics v_linhas = row_count;
  return v_linhas;
end;
$$;

comment on function public.fn_definir_frases_de_comentario(uuid, uuid, jsonb) is
  'Grava organizations.settings.comentarios (frases de abertura de conversa no Direct) com merge ATÔMICO (jsonb_set), sem tocar nas demais chaves do jsonb. Devolve linhas afetadas: 0 = a organização não existe. Papel insuficiente levanta 42501. Chamador: app/api/v1/comentarios/frases/route.ts.';

-- ── OS DOIS REVOKES (CLAUDE.md, item 9) — origens distintas de EXECUTE ──────
--
-- (A) `from public`: o grant que o Postgres dá a PUBLIC ao criar qualquer
--     função. `revoke ... from anon` NÃO o remove.
-- (B) `from anon`: o grant direto do `ALTER DEFAULT PRIVILEGES ... GRANT ALL
--     ON FUNCTIONS TO anon` do baseline, que vale para toda função criada
--     depois dele. `revoke ... from public` NÃO o remove.
--
-- `from authenticated` porque esta função é VOLÁTIL: definer que escreve,
-- alcançável por qualquer usuário logado, é escrita cross-tenant (segunda
-- regra de tests/invariants/hardening-definer-varredura.test.ts). O único
-- chamador é a rota, com o client de sessão trocado pelo admin client.
revoke execute on function public.fn_definir_frases_de_comentario(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant  execute on function public.fn_definir_frases_de_comentario(uuid, uuid, jsonb)
  to service_role;

notify pgrst, 'reload schema';
