-- 0305: trilha de auditoria encadeada por hash (achado M9).

-- Trilha de auditoria com prova de adulteração (achado M9 da auditoria de
-- 2026-09-29). Os grants já impedem os papéis do PostgREST de reescrever linhas
-- (0258), mas quem tem a `DB_URL` reescrevia sem deixar vestígio.
--
-- Cada linha nova entra numa cadeia GLOBAL: `cadeia_seq` é a posição,
-- `hash_anterior` é o `hash_linha` da linha de antes, e
--   hash_linha = sha256(hash_anterior || hash do conteúdo || hash_refs).
-- Alterar, apagar do meio ou intercalar uma linha quebra a conta de todas as
-- seguintes. `fn_verificar_cadeia_auditoria` refaz a conta, e o cron
-- `data-retention` a chama todo dia e escreve a cabeça da cadeia no log do
-- contêiner (âncora fora do banco: truncar a ponta nova aparece contra o log).
--
-- Global e não por organização: `organization_id` vira NULL quando a
-- organização é apagada (FK `on delete set null`), e uma cadeia por org perderia
-- as linhas no meio do caminho. Pelo mesmo motivo `organization_id` e
-- `actor_api_token_id` ficam num hash à parte (`hash_refs`): virar NULL por
-- cascata é legítimo e a verificação aceita; trocar por OUTRO valor, não.
--
-- Linhas anteriores a esta migration ficam fora da cadeia (`cadeia_seq` nulo);
-- reescrever o passado para encadeá-lo seria justamente o que a cadeia proíbe.
alter table public.api_audit_log add column if not exists cadeia_seq bigint;
alter table public.api_audit_log add column if not exists hash_anterior bytea;
alter table public.api_audit_log add column if not exists hash_refs bytea;
alter table public.api_audit_log add column if not exists hash_linha bytea;
create unique index if not exists api_audit_log_cadeia_seq_idx
  on public.api_audit_log (cadeia_seq) where cadeia_seq is not null;

-- O texto que entra no hash. `timezone` fixo porque a forma textual de um
-- timestamptz depende do fuso da sessão, e a verificação roda noutra sessão.
create or replace function public.fn_auditoria_hash_conteudo(a public.api_audit_log)
returns bytea language sql stable set search_path = public, pg_temp set timezone = 'UTC' as $$
  select sha256(convert_to(jsonb_build_object(
    'id', a.id, 'actor_user_id', a.actor_user_id,
    'acting_as_platform_admin', a.acting_as_platform_admin,
    'actor_ip', a.actor_ip, 'actor_user_agent', a.actor_user_agent,
    'action', a.action, 'resource_type', a.resource_type, 'resource_id', a.resource_id,
    'request_id', a.request_id, 'bypassed_rls', a.bypassed_rls,
    'metadata', a.metadata, 'created_at', a.created_at,
    'cadeia_seq', a.cadeia_seq)::text, 'UTF8'));
$$;

-- Dois hashes de 32 bytes lado a lado, um por referência, para a verificação
-- conferir cada uma sozinha.
create or replace function public.fn_auditoria_hash_refs(p_org uuid, p_token uuid)
returns bytea language sql immutable as $$
  select sha256(convert_to(coalesce(p_org::text, ''), 'UTF8'))
      || sha256(convert_to(coalesce(p_token::text, ''), 'UTF8'));
$$;

create or replace function public.fn_auditoria_encadear()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_seq bigint; v_hash bytea;
begin
  -- Serializa as inserções: sem a trava, duas transações leriam a mesma cabeça.
  perform pg_advisory_xact_lock(hashtextextended('api_audit_log:cadeia', 0));
  select a.cadeia_seq, a.hash_linha into v_seq, v_hash
    from public.api_audit_log a where a.cadeia_seq is not null
   order by a.cadeia_seq desc limit 1;
  new.cadeia_seq := coalesce(v_seq, 0) + 1;
  new.hash_anterior := v_hash;
  new.hash_refs := public.fn_auditoria_hash_refs(new.organization_id, new.actor_api_token_id);
  new.hash_linha := sha256(coalesce(v_hash, ''::bytea) || public.fn_auditoria_hash_conteudo(new) || new.hash_refs);
  return new;
end;
$$;

drop trigger if exists trg_auditoria_encadear on public.api_audit_log;
create trigger trg_auditoria_encadear before insert on public.api_audit_log
  for each row execute function public.fn_auditoria_encadear();

-- Refaz a cadeia inteira (é pequena: dezenas de milhares de linhas). A primeira
-- linha que sobrou é a âncora — o expurgo apaga só o começo da cadeia.
create or replace function public.fn_verificar_cadeia_auditoria()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  r record; v_prev_seq bigint; v_prev_hash bytea; v_linhas bigint := 0;
  v_total int := 0; v_problemas jsonb := '[]'::jsonb; v_problema text;
begin
  for r in select a.*, public.fn_auditoria_hash_conteudo(a) as conteudo
             from public.api_audit_log a where a.cadeia_seq is not null order by a.cadeia_seq loop
    v_problema := null;
    if v_prev_seq is not null and r.cadeia_seq <> v_prev_seq + 1 then
      v_problema := 'linha_removida';
    elsif v_prev_seq is not null and r.hash_anterior is distinct from v_prev_hash then
      v_problema := 'elo_quebrado';
    elsif r.hash_linha is distinct from sha256(coalesce(r.hash_anterior, ''::bytea) || r.conteudo || r.hash_refs) then
      v_problema := 'linha_alterada';
    elsif (r.organization_id is not null
           and substring(r.hash_refs from 1 for 32) <> substring(public.fn_auditoria_hash_refs(r.organization_id, null) from 1 for 32))
       or (r.actor_api_token_id is not null
           and substring(r.hash_refs from 33 for 32) <> substring(public.fn_auditoria_hash_refs(null, r.actor_api_token_id) from 33 for 32)) then
      -- Referência que virou NULL pode ser a cascata; trocada por outro valor, não.
      v_problema := 'referencia_alterada';
    end if;
    if v_problema is not null then
      v_total := v_total + 1;
      if v_total <= 20 then
        v_problemas := v_problemas || jsonb_build_object('cadeia_seq', r.cadeia_seq, 'problema', v_problema);
      end if;
    end if;
    v_linhas := v_linhas + 1;
    v_prev_seq := r.cadeia_seq;
    v_prev_hash := r.hash_linha;
  end loop;
  return jsonb_build_object('linhas', v_linhas, 'total_problemas', v_total, 'problemas', v_problemas,
    'cabeca_seq', v_prev_seq, 'cabeca_hash', encode(v_prev_hash, 'hex'));
end;
$$;

-- O expurgo passa a apagar só o COMEÇO da cadeia. `created_at` é o início da
-- transação e a posição é dada sob a trava, então as duas ordens podem divergir
-- por milissegundos na fronteira; apagar pela data abriria um buraco no meio.
create or replace function public.fn_expurgar_auditoria_vencida(p_retencao_dias int default 1825, p_limite int default 1000)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dias int := greatest(coalesce(p_retencao_dias, 1825), 90);
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 10000);
  v_corte bigint;
  v_apagadas int;
begin
  select min(b.cadeia_seq) into v_corte from public.api_audit_log b
   where b.cadeia_seq is not null and b.created_at >= now() - make_interval(days => v_dias);
  with vencidas as (
    select a.id
      from public.api_audit_log a
     where a.created_at < now() - make_interval(days => v_dias)
       and (a.cadeia_seq is null or a.cadeia_seq < coalesce(v_corte, 9223372036854775807))
     order by a.cadeia_seq nulls first, a.created_at
     limit v_limite
  )
  delete from public.api_audit_log a
   using vencidas v
   where a.id = v.id;
  get diagnostics v_apagadas = row_count;
  return v_apagadas;
end;
$$;

revoke execute on function public.fn_auditoria_hash_conteudo(public.api_audit_log) from public, anon, authenticated;
revoke execute on function public.fn_auditoria_hash_refs(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.fn_auditoria_encadear() from public, anon, authenticated;
revoke execute on function public.fn_verificar_cadeia_auditoria() from public, anon, authenticated;
grant execute on function public.fn_verificar_cadeia_auditoria() to service_role;
revoke execute on function public.fn_expurgar_auditoria_vencida(int, int) from public, anon, authenticated;
grant execute on function public.fn_expurgar_auditoria_vencida(int, int) to service_role;
