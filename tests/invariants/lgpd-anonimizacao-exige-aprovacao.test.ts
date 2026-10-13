/**
 * ANONIMIZAR POR PEDIDO EXIGE APROVAÇÃO PROVADA NA LINHA DO PEDIDO (migration 0357).
 *
 * O defeito: o `lgpd-redact-worker` anonimizava ao receber o evento
 * `lgpd.redact_received`, sem olhar se alguém tinha aprovado. O evento era a
 * autorização, e evento qualquer um do servidor emite: o webhook da loja emitia
 * ao criar o pedido, e bastava um `emit_event` a mais (uma automação, um evento
 * reprocessado) para um paciente ser anonimizado, sem volta, sem ninguém ter
 * decidido.
 *
 * O que este arquivo prova, no Postgres de verdade:
 *
 *   - a regra é uma só, `fn_lgpd_recusa_do_redact`, e ela lê a LINHA DO PEDIDO,
 *     nunca o evento: quem aprovou (administrador daquela organização), quando,
 *     por quê, para AQUELE pedido e AQUELE contato;
 *   - a cascata (`fn_lgpd_cascade_redact_contact`), que é onde o irreversível
 *     acontece, recusa o pedido não aprovado seja qual for o evento na fila, e o
 *     contato e as mensagens ficam como estavam;
 *   - aprovação de outra organização, de outro pedido ou de outro contato não vale;
 *   - aprovado, anonimiza; chamado duas vezes, anonimiza uma vez só.
 *
 * O que NÃO está aqui: o worker em si (ele fala com o banco pelo PostgREST, que
 * o `test:db` não sobe). Ele está em `tests/unit/lgpd-redact-so-com-aprovacao.test.ts`.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { GOV_ADMIN, GOV_AGENT_A, GOV_CONTACT_1, GOV_CONTACT_2, GOV_CONV_UNASSIGNED, GOV_ORG, GOV_SESSION, lastLine, seedGov, sql } from "./gov-helpers";
import { sqlPedidoAprovado } from "./lgpd-pedido-aprovado";
import { motivoDoErro } from "./psql-transporte";

const ORG = GOV_ORG;
const CONTATO = GOV_CONTACT_1;
const OUTRO_CONTATO = GOV_CONTACT_2;
const ORG_VIZINHA = "03570000-0000-4000-8000-0000000000b0";
const ADMIN_VIZINHO = "03570000-0000-4000-8000-0000000000b1";
const PEDIDO = "03570000-0000-4000-8000-000000000001";
const OUTRO_PEDIDO = "03570000-0000-4000-8000-000000000002";
const PEDIDO_DE_DADOS = "03570000-0000-4000-8000-000000000003";
const NOME = "Paciente Do Portao";
const TEXTO = "minha pressão está em 14 por 9";

const valor = (q: string) => lastLine(sql(q));
const recusa = (pedido = PEDIDO, org = ORG, contato: string | null = null) =>
  valor(
    `select coalesce(public.fn_lgpd_recusa_do_redact('${org}', '${pedido}', ${contato ? `'${contato}'` : "null"}), 'APROVADO');`,
  );

/** O que não pode mudar em nenhuma recusa: o contato e a mensagem dele. */
const retrato = () =>
  valor(`select c.display_name || '|' || c.is_anonymized::text || '|' || m.body
           from contacts c join messages m on m.contact_id = c.id
          where c.id = '${CONTATO}' and m.organization_id = '${ORG}' limit 1;`);
const INTACTO = `${NOME}|false|${TEXTO}`;

function cascata(pedido = PEDIDO, org = ORG, contato = CONTATO): string {
  try {
    return valor(`select public.fn_lgpd_cascade_redact_contact('${org}', '${contato}', '${pedido}')::text;`);
  } catch (e) {
    return `ERRO ${motivoDoErro(e)}`;
  }
}

function aprovar(campos: Record<string, string | null> = {}, pedido = PEDIDO): void {
  const base: Record<string, string | null> = {
    request_id: pedido,
    organization_id: ORG,
    contact_id: CONTATO,
    approved_by: GOV_ADMIN,
    approved_at: "2026-10-12T15:00:00.000Z",
    approved_reason: "Paciente pediu por escrito no balcão",
    ...campos,
  };
  sql(`update lgpd_requests set request_payload = request_payload || jsonb_build_object('approval', '${JSON.stringify(base)}'::jsonb)
        where id = '${pedido}';`);
}

beforeEach(() => {
  seedGov();
  sql(`
    insert into auth.users (id, email) values ('${ADMIN_VIZINHO}', 'admin-vizinho@invariant.test') on conflict do nothing;
    insert into organizations (id, slug, legal_name, display_name)
      values ('${ORG_VIZINHA}', 'portao-vizinha', 'Org Vizinha', 'Org Vizinha') on conflict do nothing;
    insert into user_organizations (user_id, organization_id, role, accepted_at)
      values ('${ADMIN_VIZINHO}', '${ORG_VIZINHA}', 'admin', now()) on conflict do nothing;
    delete from event_log where organization_id = '${ORG}' and entity_id in ('${PEDIDO}', '${OUTRO_PEDIDO}');
    delete from storage_redaction_queue where organization_id = '${ORG}';
    delete from lgpd_requests where id in ('${PEDIDO}', '${OUTRO_PEDIDO}', '${PEDIDO_DE_DADOS}');
    delete from messages where organization_id = '${ORG}' and contact_id = '${CONTATO}';
    -- a anonimização é irreversível (gatilho); o reset é do FIXTURE.
    set session_replication_role = replica;
    update contacts set display_name = '${NOME}', name = '${NOME}', is_anonymized = false, anonymized_at = null
     where id in ('${CONTATO}', '${OUTRO_CONTATO}') and organization_id = '${ORG}';
    set session_replication_role = default;
    insert into messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, body, sent_at)
      values ('${ORG}', '${GOV_CONV_UNASSIGNED}', '${GOV_SESSION}', '${CONTATO}', 'text', 'inbound', 'delivered', '${TEXTO}', now());
    insert into lgpd_requests (id, organization_id, request_type, source, scope, contact_id, due_at) values
      ('${PEDIDO}', '${ORG}', 'redact', 'manual', 'contact', '${CONTATO}', now() + interval '15 days'),
      ('${OUTRO_PEDIDO}', '${ORG}', 'redact', 'manual', 'contact', '${OUTRO_CONTATO}', now() + interval '15 days'),
      ('${PEDIDO_DE_DADOS}', '${ORG}', 'data_request', 'manual', 'contact', '${CONTATO}', now() + interval '7 days');
  `);
});

describe("pedido NÃO aprovado nunca anonimiza, chegue o evento como chegar", () => {
  it("pedido só registrado: a regra recusa e a cascata não toca em nada", () => {
    expect(recusa()).toBe("not_approved");
    expect(cascata()).toMatch(/lgpd_redact_not_approved: not_approved/);
    expect(retrato()).toBe(INTACTO);
  });

  it("evento emitido direto, com 'aprovação' escrita no PAYLOAD do evento, não vale nada", () => {
    sql(`select public.emit_event('lgpd.redact_received', 'lgpd_request', '${PEDIDO}',
           jsonb_build_object('request_id', '${PEDIDO}', 'manually_approved', true,
                              'approved_by', '${GOV_ADMIN}', 'approved_reason', 'forjado no evento, sem tela'),
           '{"manually_approved": true}'::jsonb, '${ORG}');`);
    expect(recusa()).toBe("not_approved");
    expect(cascata()).toMatch(/lgpd_redact_not_approved/);
    expect(retrato()).toBe(INTACTO);
  });

  it("pedido que veio da loja (webhook) espera aprovação como qualquer outro", () => {
    sql(`update lgpd_requests set source = 'nuvemshop', external_customer_id = '991',
                request_payload = '{"customer": {"id": 991}, "store_id": "7"}'::jsonb
          where id = '${PEDIDO}';
         select public.emit_event('lgpd.redact_received', 'lgpd_request', '${PEDIDO}',
           '{"scope": "contact", "emergency": false}'::jsonb, '{"store_id": "7"}'::jsonb, '${ORG}');`);
    expect(recusa()).toBe("not_approved");
    expect(cascata()).toMatch(/lgpd_redact_not_approved/);
    expect(retrato()).toBe(INTACTO);
  });

  it("o mesmo evento repetido (reprocessado) continua recusado", () => {
    for (let i = 0; i < 2; i++) {
      sql(`select public.emit_event('lgpd.redact_received', 'lgpd_request', '${PEDIDO}', '{}'::jsonb, '{}'::jsonb, '${ORG}');`);
      expect(cascata()).toMatch(/lgpd_redact_not_approved/);
    }
    expect(retrato()).toBe(INTACTO);
  });

  it("pedido da organização inteira (loja desinstalada) também espera aprovação", () => {
    sql(`update lgpd_requests set request_type = 'store_redact', scope = 'tenant', contact_id = null, emergency = true
          where id = '${PEDIDO}';`);
    expect(recusa()).toBe("not_approved");
    expect(cascata()).toMatch(/lgpd_redact_not_approved/);
    expect(retrato()).toBe(INTACTO);
  });
});

describe("aprovação que não é deste pedido, desta organização, de um administrador, não vale", () => {
  it.each<[string, Record<string, string | null>, string]>([
    ["de outro pedido", { request_id: OUTRO_PEDIDO }, "approval_for_another_request"],
    ["de outra organização", { organization_id: ORG_VIZINHA }, "approval_for_another_organization"],
    ["para outro contato", { contact_id: OUTRO_CONTATO }, "approval_for_another_contact"],
    ["sem justificativa", { approved_reason: "ok" }, "approval_without_reason"],
    ["sem data", { approved_at: null }, "approval_without_timestamp"],
    ["sem aprovador", { approved_by: null }, "approval_without_approver"],
    ["de quem não é administrador", { approved_by: GOV_AGENT_A }, "approver_not_admin"],
    ["de administrador de OUTRA organização", { approved_by: ADMIN_VIZINHO }, "approver_not_admin"],
  ])("aprovação %s", (_nome, campos, motivo) => {
    aprovar(campos);
    expect(recusa()).toBe(motivo);
    expect(cascata()).toMatch(new RegExp(`lgpd_redact_not_approved: ${motivo}`));
    expect(retrato()).toBe(INTACTO);
  });

  it("o pedido aprovado de um contato não anonimiza OUTRO contato", () => {
    aprovar({ contact_id: OUTRO_CONTATO }, OUTRO_PEDIDO);
    expect(recusa(OUTRO_PEDIDO)).toBe("APROVADO");
    expect(cascata(OUTRO_PEDIDO, ORG, CONTATO)).toMatch(/lgpd_redact_not_approved: contact_outside_request/);
    expect(retrato()).toBe(INTACTO);
  });

  it("pedido lido por outra organização não existe para ela", () => {
    aprovar();
    expect(recusa(PEDIDO, ORG_VIZINHA)).toBe("request_not_found");
  });

  it("pedido de DADOS aprovado não autoriza anonimização", () => {
    aprovar({}, PEDIDO_DE_DADOS);
    expect(recusa(PEDIDO_DE_DADOS)).toBe("wrong_request_type");
    expect(cascata(PEDIDO_DE_DADOS)).toMatch(/lgpd_redact_not_approved: wrong_request_type/);
    expect(retrato()).toBe(INTACTO);
  });

  it("administrador que saiu da organização deixa de valer como aprovador", () => {
    aprovar();
    sql(`update user_organizations set revoked_at = now() where user_id = '${GOV_ADMIN}' and organization_id = '${ORG}';`);
    try {
      expect(recusa()).toBe("approver_not_admin");
    } finally {
      sql(`update user_organizations set revoked_at = null where user_id = '${GOV_ADMIN}' and organization_id = '${ORG}';`);
    }
  });
});

describe("aprovado, anonimiza, e uma vez só", () => {
  it("a rota de aprovação e o fixture gravam o mesmo formato, e ele passa", () => {
    sql(sqlPedidoAprovado(PEDIDO, ORG));
    expect(recusa()).toBe("APROVADO");
  });

  it("anonimiza o contato e a mensagem; a segunda chamada não refaz nada", () => {
    aprovar();
    expect(recusa(PEDIDO, ORG, CONTATO)).toBe("APROVADO");

    const primeira = JSON.parse(cascata()) as { already_anonymized: boolean };
    expect(primeira.already_anonymized).toBe(false);
    expect(valor(`select display_name || '|' || is_anonymized::text from contacts where id = '${CONTATO}';`)).toBe(
      `Cliente Anonimizado #${CONTATO.slice(0, 8)}|true`,
    );
    expect(valor(`select count(*) from messages where contact_id = '${CONTATO}' and body = '${TEXTO}';`)).toBe("0");

    const segunda = JSON.parse(cascata()) as { already_anonymized: boolean };
    expect(segunda.already_anonymized).toBe(true);
    expect(
      valor(`select count(*) from api_audit_log where action = 'lgpd.redact_executed'
              and organization_id = '${ORG}' and metadata->>'request_id' = '${PEDIDO}';`),
    ).toBe("1");
  });

  it("sem pedido (o botão da ficha, que tem o portão dele) a cascata segue como era", () => {
    const r = JSON.parse(
      valor(`select public.fn_lgpd_cascade_redact_contact('${ORG}', '${CONTATO}', null)::text;`),
    ) as { already_anonymized: boolean };
    expect(r.already_anonymized).toBe(false);
  });
});

describe("a regra não é alcançável pela REST de quem está logado", () => {
  it.each(["anon", "authenticated"])("%s não executa fn_lgpd_recusa_do_redact", (papel) => {
    expect(valor(`select has_function_privilege('${papel}', 'public.fn_lgpd_recusa_do_redact(uuid,uuid,uuid)', 'execute')::text;`)).toBe("false");
  });
  it("service_role executa", () => {
    expect(valor(`select has_function_privilege('service_role', 'public.fn_lgpd_recusa_do_redact(uuid,uuid,uuid)', 'execute')::text;`)).toBe("true");
  });
});
