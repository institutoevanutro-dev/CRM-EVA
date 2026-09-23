-- 0275 — decrypt_cpf: a leitura do CPF guardado cifrado pela 0274.
--
-- A 0274 fechou o lado da escrita (todo CPF entra como par hash+cifra). Sem uma
-- função de leitura, o CPF fica guardado e invisível: a ficha do contato só sabe
-- dizer que "existe CPF". Esta função é o outro lado, e o produto a chama em
-- `app/api/v1/contacts/_handler.ts` (GET com cabeçalho `X-Decrypt-Purpose`).
--
-- **Só `service_role` executa, e isso é a segurança inteira.** A função recebe
-- o id da ficha e devolve o CPF em claro; ela NÃO sabe quem está perguntando nem
-- de que organização. Quem sabe é o handler, que já leu a ficha filtrando por
-- `organization_id`, já conferiu o papel de quem pede e já registra a consulta
-- em `api_audit_log`. Se `authenticated` pudesse executá-la, a anon key do
-- browser alcançaria o CPF de QUALQUER ficha de QUALQUER organização pela REST,
-- por cima de toda essa checagem — que é exatamente o defeito que a issue #128
-- catalogou para outras definer.
--
-- Mesma chave e mesmo domínio da 0274 (`'cpf:' || chave`): ciphertext de segredo
-- de webhook/OAuth não abre por aqui. Idempotente (create or replace + grants).

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create or replace function public.decrypt_cpf(p_contact_id uuid) returns text
    language plpgsql stable security definer
    set search_path to 'public', 'private', 'extensions', 'pg_temp'
    as $$
declare
  k text := private.fn_oauth_key();
  v_cifra bytea;
begin
  if k is null or length(k) < 32 then
    raise exception 'chave de cifra da instalação ausente — rode o update.sh'
      using errcode = '55000';
  end if;
  select cpf_encrypted into v_cifra from public.contacts where id = p_contact_id;
  -- As MESMAS três guardas de forma da 0240 (`fn_decrypt_oauth`), pelo mesmo
  -- motivo: sem elas, uma linha cujo `cpf_encrypted` não é pacote de verdade
  -- vira erro 500 permanente e indistinguível de chave trocada. Aqui a coluna é
  -- nullable (não há byte de enfeite), mas a ordem continua obrigatória:
  -- `get_byte()` em bytea vazio estoura antes de qualquer comparação.
  if v_cifra is null then
    return null;                      -- ficha sem CPF: silêncio, não é erro
  end if;
  if octet_length(v_cifra) < 66 then
    return null;                      -- curto demais para ser pacote deste par
  end if;
  if get_byte(v_cifra, 0) < 128 then
    return null;                      -- sem cara de pacote PGP (bit 7)
  end if;
  -- Daqui para baixo só chega pacote de verdade: se não abrir, é chave trocada
  -- ou dado corrompido, e isso TEM de aparecer.
  return pgp_sym_decrypt(v_cifra, 'cpf:' || k);
end$$;

revoke execute on function public.decrypt_cpf(uuid) from public, anon, authenticated;
grant  execute on function public.decrypt_cpf(uuid) to service_role;
