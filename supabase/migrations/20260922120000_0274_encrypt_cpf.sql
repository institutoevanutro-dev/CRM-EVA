-- 0274 — encrypt_cpf: a cifra at-rest do CPF que o código chamava e o schema
-- nunca teve.
--
-- O defeito, medido em produção (22/09/2026): importar um CSV com coluna CPF
-- derrubou 483 de 500 linhas em `contacts_cpf_consistency` (cpf_encrypted e
-- cpf_hash são par: os dois nulos ou os dois preenchidos). O app gravava o hash
-- sempre e a cifra só quando `rpc('encrypt_cpf')` respondia — e a função não
-- existia em migration nem no baseline, então a RPC falhava em TODA instalação.
-- Criar/editar contato com CPF pela tela caía no mesmo 500.
--
-- Chave: a MESMA chave da instalação que já cifra os segredos (private.fn_oauth_key,
-- migration 0041), semeada pelo install.sh/update.sh (`ensure_encryption_key`).
-- Nenhuma variável nova, nenhuma ação do operador. Com separação de domínio:
-- o CPF é cifrado com 'cpf:' || chave, então nenhum ciphertext de segredo
-- (webhook/OAuth) decifra pelo caminho do CPF e vice-versa.
--
-- Só `service_role` executa: o app chama com o admin client. A função não
-- recebe organização nem lê linha — é cifra pura de 11 dígitos —, então não é
-- porta de leitura cross-tenant. Idempotente (create or replace + grants).

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create or replace function public.encrypt_cpf(p_plaintext text) returns bytea
    language plpgsql volatile security definer
    set search_path to 'public', 'private', 'extensions', 'pg_temp'
    as $$
declare
  k text := private.fn_oauth_key();
  v_digitos text := regexp_replace(coalesce(p_plaintext, ''), '\D', '', 'g');
begin
  if k is null or length(k) < 32 then
    raise exception 'chave de cifra da instalação ausente — rode o update.sh'
      using errcode = '55000';
  end if;
  if length(v_digitos) <> 11 then
    raise exception 'CPF deve ter 11 dígitos' using errcode = '22023';
  end if;
  return pgp_sym_encrypt(v_digitos, 'cpf:' || k, 'cipher-algo=aes256');
end$$;

revoke execute on function public.encrypt_cpf(text) from public, anon, authenticated;
grant  execute on function public.encrypt_cpf(text) to service_role;
