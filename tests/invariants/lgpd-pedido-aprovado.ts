/**
 * Fixture: SQL que deixa um pedido de anonimização APROVADO, do jeito que a
 * rota `POST /api/v1/lgpd/requests/[id]/approve` o deixa.
 *
 * Desde a migration 0357 a cascata (`fn_lgpd_cascade_redact_contact`) recusa o
 * pedido que existe e não prova aprovação. Os invariantes que chamam a cascata
 * com um pedido de verdade (a fila de mídia tem FK para ele) querem medir a
 * cascata, não o portão: aprovam o pedido com este trecho e seguem.
 *
 * Quem aprova é um administrador da organização do pedido, criado aqui se ainda
 * não existir. O portão em si é medido em
 * `lgpd-anonimizacao-exige-aprovacao.test.ts`.
 */
export const APROVADOR_DE_FIXTURE = "0357a000-0000-4000-8000-0000000000ad";

export function sqlPedidoAprovado(pedido: string, org: string, aprovador = APROVADOR_DE_FIXTURE): string {
  return `
    insert into auth.users (id, email)
      values ('${aprovador}', 'aprovador-${aprovador.slice(0, 8)}@invariant.test') on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${aprovador}', '${org}', 'admin', now()) on conflict do nothing;
    update public.lgpd_requests r
       set request_payload = r.request_payload || jsonb_build_object('approval', jsonb_build_object(
             'request_id', r.id,
             'organization_id', r.organization_id,
             'contact_id', r.contact_id,
             'approved_by', '${aprovador}',
             'approved_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
             'approved_reason', 'Pedido do titular conferido pelo fixture'))
     where r.id = '${pedido}' and r.organization_id = '${org}';
  `;
}
