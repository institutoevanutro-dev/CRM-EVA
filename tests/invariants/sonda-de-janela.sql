-- SONDA DE JANELA NA REAPLICAÇÃO DO BASELINE.
--
-- Usada por `reaplicar-o-baseline-nao-abre-janela.test.ts`. Não é migration e
-- não vai para banco de cliente: vive só no Postgres efêmero do `pnpm test:db`.
--
-- O `update.sh` reaplica o `baseline.sql` inteiro com `psql` puro: sem transação
-- única, cada comando é confirmado sozinho, com gente usando o sistema. Tudo o
-- que existe no estado FINAL e some entre dois comandos, ou que não existe no
-- estado final e aparece entre dois comandos, é uma janela que outra sessão vê.
--
-- A sonda fotografa o estado final (`_janela.estavel`) e, a cada comando de DDL
-- (gatilho de evento em `ddl_command_end`), grava a diferença para a foto. O
-- `txid` separa os comandos de topo: o que acontece DENTRO de um bloco `do` é
-- uma transação só e ninguém de fora enxerga; vale a última linha de cada txid.
--
-- A foto cobre PRIVILÉGIO (o que cada papel do PostgREST pode) e OBJETO (policy,
-- gatilho, coluna, constraint, índice, view e definição de função).

create schema if not exists _janela;

-- PRIVILÉGIO EFETIVO dos três papéis do PostgREST. É o que o teste cobra.
create or replace function _janela.privilegios()
returns table (classe text, fato text)
language sql stable
-- search_path fixo: o dump troca o da sessão, e `regclass::text` mudaria junto.
set search_path = '' as $privilegios$
  with papeis(papel) as (values ('anon'), ('authenticated'), ('service_role'))
  -- EXECUTE efetivo (conta o grant a PUBLIC, que é o que o papel sente).
  select 'executar', papel || ' ' || p.oid::regprocedure::text
    from pg_proc p, papeis
   where p.pronamespace = 'public'::regnamespace
     and has_function_privilege(papel, p.oid, 'execute')
  union all
  select 'tabela', papel || ' ' || priv || ' ' || c.relname
    from pg_class c, papeis,
         unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) priv
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v','m','p')
     and has_table_privilege(papel, c.oid, priv)
  union all
  -- Só SELECT e UPDATE têm grant por coluna neste schema; e só onde o papel NÃO
  -- tem o privilégio na tabela inteira (senão a linha de `tabela` já conta).
  select 'coluna', papel || ' ' || priv || ' ' || c.relname || '.' || a.attname
    from pg_attribute a join pg_class c on c.oid = a.attrelid, papeis,
         unnest(array['SELECT','UPDATE']) priv
   where c.relnamespace = 'public'::regnamespace and a.attnum > 0 and not a.attisdropped
     and c.relkind in ('r','v','m','p')
     and not has_table_privilege(papel, c.oid, priv)
     and has_column_privilege(papel, c.oid, a.attnum, priv)
  union all
  select 'sequencia', papel || ' ' || priv || ' ' || c.relname
    from pg_class c, papeis, unnest(array['USAGE','SELECT','UPDATE']) priv
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'S'
     and has_sequence_privilege(papel, c.oid, priv)
  union all
  select 'schema', papel || ' USAGE ' || n.nspname
    from pg_namespace n, papeis
   where n.nspname = 'public' and has_schema_privilege(papel, n.oid, 'usage')
$privilegios$;

-- O RESTO do que protege ou sustenta uma requisição: policy, gatilho, coluna,
-- constraint, índice, view e corpo de função. O teste cobra tudo isto também.
create or replace function _janela.objetos()
returns table (classe text, fato text)
language sql stable
set search_path = '' as $objetos$
  select 'policy', format('%s.%s %s [%s %s %s] using=%s check=%s', schemaname, tablename, policyname,
                          permissive, cmd, roles, md5(coalesce(qual, '')), md5(coalesce(with_check, '')))
    from pg_policies where schemaname in ('public', 'storage')
  union all
  select 'rls', c.relname || case when c.relforcerowsecurity then ' (force)' else '' end
    from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') and c.relrowsecurity
  union all
  select 'gatilho', format('%s %s [%s] %s', t.tgrelid::regclass, t.tgname, t.tgenabled, md5(pg_get_triggerdef(t.oid)))
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where not t.tgisinternal and c.relnamespace in ('public'::regnamespace, 'storage'::regnamespace)
  union all
  select 'atributo', format('%s.%s %s', c.relname, a.attname, format_type(a.atttypid, a.atttypmod))
    from pg_attribute a join pg_class c on c.oid = a.attrelid
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p')
     and a.attnum > 0 and not a.attisdropped
  union all
  select 'constraint', format('%s %s %s', k.conrelid::regclass, k.conname, md5(pg_get_constraintdef(k.oid)))
    from pg_constraint k
   where k.connamespace = 'public'::regnamespace and k.conrelid <> 0
  union all
  select 'indice', format('%s %s', i.indexrelid::regclass, md5(pg_get_indexdef(i.indexrelid)))
    from pg_index i join pg_class c on c.oid = i.indexrelid
   where c.relnamespace = 'public'::regnamespace and i.indisvalid
  union all
  select 'view', format('%s %s %s', c.relname, coalesce(c.reloptions::text, '{}'), md5(pg_get_viewdef(c.oid)))
    from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('v','m')
  union all
  -- Corpo e atributos da função: `create or replace` com corpo ANTIGO mais acima
  -- no arquivo devolve a versão antiga até a definição nova passar.
  -- A definição inteira (linguagem, volatilidade, `security definer`, `set`,
  -- retorno e corpo), como o `pg_get_functiondef` a imprime.
  select 'funcao', format('%s %s', p.oid::regprocedure, md5(pg_get_functiondef(p.oid)))
    from pg_proc p
    left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
   where p.pronamespace = 'public'::regnamespace and d.objid is null and p.prokind in ('f', 'p')
$objetos$;

-- Tudo: privilégios e objetos.
create or replace function _janela.fatos()
returns table (classe text, fato text)
language sql stable as $fatos$
  select * from _janela.privilegios()
  union all
  select * from _janela.objetos()
$fatos$;

create table if not exists _janela.estavel (classe text not null, fato text not null);
-- Uma linha por comando de DDL. `classes` diz QUAIS classes aquela linha
-- refotografou; as que ficaram de fora valem pela linha anterior delas.
create table if not exists _janela.registro (
  seq bigserial primary key,
  txid bigint not null default txid_current(),
  tag text not null,
  comando text not null,
  classes text[] not null,
  faltando text[] not null,
  sobrando text[] not null
);

create or replace function _janela.ao_fim_do_ddl() returns event_trigger
language plpgsql set search_path = '' as $ao_fim$
declare
  de_privilegio constant text[] := array['executar','tabela','coluna','sequencia','schema'];
  de_objeto constant text[] := array['policy','rls','gatilho','atributo','constraint','indice','view','funcao'];
  alvo text[];
  falta text[];
  sobra text[];
begin
  -- A foto inteira custa caro e o arquivo tem milhares de comandos: cada comando
  -- refotografa só as classes que o tipo dele consegue mexer. O que não está
  -- nesta lista refotografa TUDO (alter table, drop com cascade, create view...).
  alvo := case
    when tg_tag = 'COMMENT' then null
    when tg_tag in ('GRANT', 'REVOKE') then de_privilegio
    when tg_tag in ('CREATE FUNCTION', 'ALTER FUNCTION') then array['funcao', 'executar']
    when tg_tag in ('CREATE POLICY', 'ALTER POLICY', 'DROP POLICY') then array['policy']
    when tg_tag in ('CREATE TRIGGER', 'DROP TRIGGER') then array['gatilho', 'constraint']
    when tg_tag in ('CREATE INDEX', 'DROP INDEX') then array['indice', 'constraint']
    else de_privilegio || de_objeto
  end;
  if alvo is null then return; end if;
  -- `create ... if not exists` sobre o que já existe não mexe em nada.
  if tg_tag in ('CREATE TABLE', 'CREATE INDEX', 'CREATE SEQUENCE', 'CREATE SCHEMA', 'CREATE EXTENSION')
     and not exists (select 1 from pg_event_trigger_ddl_commands()) then
    return;
  end if;
  with agora as materialized (
         select classe || ': ' || fato as f from _janela.privilegios() where alvo && de_privilegio and classe = any (alvo)
         union all
         select classe || ': ' || fato from _janela.objetos() where alvo && de_objeto and classe = any (alvo)),
       antes as materialized (select classe || ': ' || fato as f from _janela.estavel where classe = any (alvo))
  select coalesce((select array_agg(f order by f) from (select f from antes except select f from agora) x), '{}'),
         coalesce((select array_agg(f order by f) from (select f from agora except select f from antes) x), '{}')
    into falta, sobra;
  insert into _janela.registro (tag, comando, classes, faltando, sobrando)
  values (tg_tag, left(regexp_replace(current_query(), '\s+', ' ', 'g'), 300), alvo, falta, sobra);
end
$ao_fim$;

-- Uma janela = um fato fora do lugar ao FIM de um comando de topo, do primeiro
-- comando que o tira do lugar até o que o devolve. Para cada classe vale a
-- última linha de cada txid que a refotografou, e ela vale até a próxima.
create or replace view _janela.janelas as
with num as (
  select txid, dense_rank() over (order by txid) as n from (select distinct txid from _janela.registro) t
), fim as (
  select distinct on (r.txid, c.classe) r.seq, r.txid, r.comando, c.classe, r.faltando, r.sobrando
    from _janela.registro r, unnest(r.classes) as c(classe)
   order by r.txid, c.classe, r.seq desc
), ponto as (
  select f.*, n.n, coalesce(lead(n.n) over (partition by f.classe order by n.n), n.n + 1) - n.n as dura
    from fim f join num n using (txid)
), solto as (
  select seq, comando, dura, 'falta' as sentido, f as fato from ponto, unnest(faltando) f where f like classe || ': %'
  union all
  select seq, comando, dura, 'sobra', f from ponto, unnest(sobrando) f where f like classe || ': %'
)
select sentido, fato, min(seq) as abre_seq, max(seq) as ultimo_seq, sum(dura) as comandos_de_ddl,
       (array_agg(comando order by seq))[1] as abre_em
  from solto group by sentido, fato;
