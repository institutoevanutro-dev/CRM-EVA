-- 0301: segundo fator vale também na REST (achado A5).
-- Detalhes no apêndice do baseline.sql e no MANIFEST.

-- Quem cadastrou o segundo fator precisa prová-lo também para ler e gravar
-- direto pela REST (PostgREST/Realtime). Até aqui a exigência de `aal2` só
-- existia no Next (`mfaEmDivida`): com a senha de quem tem TOTP, um JWT `aal1`
-- tirado de `/auth/v1/token` lia contatos, conversas e mensagens da
-- organização inteira. Achado A5 da auditoria de 2026-09-29.
--
-- Uma policy RESTRITIVA por tabela com `organization_id`: ela se SOMA (AND) às
-- permissivas que já existem, então não abre nada; só fecha para a sessão
-- `aal1` de quem tem fator verificado. Quem não cadastrou fator passa como
-- antes (`fn_session_mfa_proven` devolve true), e `service_role` ignora RLS.
--
-- Só onde já há policy PERMISSIVA: tabela sem nenhuma (ex.: credenciais de
-- anúncio) já não é servida pelo PostgREST, e uma policy ali a tornaria servível.
--
-- Exceção: `user_organizations`. O `loadAuthUser` lê o vínculo com a
-- sessão do usuário ANTES do desafio do segundo fator; sem ele a pessoa cairia
-- em "acesso revogado" em vez de `/login/mfa`. O vínculo não é dado de paciente.
--
-- Varre o catálogo em vez de listar: tabela nova com `organization_id` fica
-- coberta na próxima aplicação do baseline, e o invariante
-- `tests/invariants/mfa-na-rest.test.ts` reprova a que escapar.
grant execute on function public.fn_session_mfa_proven() to authenticated;

do $$
declare t record;
begin
  for t in
    select c.relname
      from pg_class c
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped
     where c.relnamespace = 'public'::regnamespace
       and c.relkind in ('r', 'p')
       and c.relname <> 'user_organizations'
       and exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polpermissive)
  loop
    execute format('drop policy if exists mfa_provada on public.%I', t.relname);
    execute format(
      'create policy mfa_provada on public.%I as restrictive for all to authenticated '
      'using ((select public.fn_session_mfa_proven())) with check ((select public.fn_session_mfa_proven()))',
      t.relname);
  end loop;
end $$;
