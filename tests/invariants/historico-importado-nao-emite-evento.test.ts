/**
 * Migration 0297 — mensagem IMPORTADA DO HISTÓRICO do celular (coexistência)
 * não acorda ninguém. `messages` tem três AFTER INSERT; os três leem a marca
 * `metadata.importada_do_historico`. O segundo caso insere SEM a marca e prova
 * que a régua mede (senão "zero" seria só um banco que nunca conta).
 */
import { beforeAll, describe, expect, it } from "vitest";

import { GOV_CONTACT_1, GOV_CONV_UNASSIGNED, GOV_ORG, GOV_SESSION, seedGov, sql } from "./gov-helpers";

const n = (q: string) => Number(sql(q).trim());
const eventos = () => n(`select count(*) from public.event_log where organization_id = '${GOV_ORG}' and event_type like 'message.%'`);
const demandas = () => n(`select count(*) from public.demandas where organization_id = '${GOV_ORG}'`);
const revisao = () => n(`select reply_context_revision from public.conversations where id = '${GOV_CONV_UNASSIGNED}'`);

function inserir(externalId: string, metadata: string): void {
  sql(`insert into public.messages
         (organization_id, conversation_id, channel_session_id, contact_id, direction, status, type, body, external_id, sent_at, metadata)
       values ('${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', '${GOV_SESSION}', '${GOV_CONTACT_1}', 'inbound', 'delivered', 'text', 'oi',
               '${externalId}', now() - interval '30 days', '${metadata}'::jsonb);`);
}

describe("mensagem importada do histórico não acorda ninguém (0297)", () => {
  beforeAll(() => seedGov());

  it("inbound marcado como importado: zero event_log, zero demanda, revisão intacta", () => {
    const antes = [eventos(), demandas(), revisao()];
    inserir("wamid.HIST1", '{"importada_do_historico": true}');
    expect([eventos(), demandas(), revisao()]).toEqual(antes);
  });

  // A revisão anda MAIS de 1 sem a marca: o próprio inbound (+1) e a demanda que
  // ele abre, que reescreve a conversa (`fn_reply_conversation_revision`, +1).
  it("o mesmo insert SEM a marca: +1 event_log, +1 demanda, revisão anda (prova que a régua mede)", () => {
    const [e0, d0, r0] = [eventos(), demandas(), revisao()];
    inserir("wamid.VIVA1", "{}");
    expect(eventos()).toBe(e0 + 1);
    expect(demandas()).toBe(d0 + 1);
    expect(revisao()).toBeGreaterThan(r0);
  });

  it("as três funções do gatilho têm a guarda e as duas security definer seguem revogadas de anon/authenticated/public", () => {
    for (const fn of ["fn_emit_message_event", "fn_demanda_abre_no_inbound", "fn_reply_inbound_revision"]) {
      expect(sql(`select prosrc from pg_proc where proname = '${fn}' and pronamespace = 'public'::regnamespace`)).toContain("importada_do_historico");
    }
    for (const fn of ["fn_demanda_abre_no_inbound", "fn_reply_inbound_revision"]) {
      expect(sql(`select coalesce(string_agg(r, ','), '') from unnest(array['anon','authenticated','public']) r
                  where has_function_privilege(r, 'public.${fn}()', 'execute')`).trim()).toBe("");
    }
  });
});

/**
 * Conversa criada SÓ pelo histórico nasce encerrada (ruling T11): senão cada
 * conversa antiga entra na fila (`trg_conversation_routing_requested`) e o
 * roteamento atribui / abre aviso de "aguarda responsável" por conversa.
 * Conversa que já existe não muda; mensagem real depois reabre como hoje.
 */
describe("conversa criada pelo histórico nasce encerrada (0297)", () => {
  const C_HIST = "cccccccc-3333-4000-8000-0000000002a1";
  const C_VIVO = "cccccccc-3333-4000-8000-0000000002a2";
  const roteamentos = (conv: string) =>
    n(`select count(*) from public.event_log where organization_id = '${GOV_ORG}' and event_type = 'conversation.routing_requested' and entity_id = '${conv}'`);
  const upsert = (fn: string, contato: string) =>
    sql(`select public.${fn}('${GOV_ORG}', '${contato}', '${GOV_SESSION}')`).trim();
  const status = (conv: string) => sql(`select status from public.conversations where id = '${conv}'`).trim();

  beforeAll(() => {
    seedGov();
    sql(`insert into public.contacts (id, organization_id, display_name) values
           ('${C_HIST}', '${GOV_ORG}', 'Histórico'), ('${C_VIVO}', '${GOV_ORG}', 'Ao vivo') on conflict do nothing;`);
  });

  it("variante do histórico: conversa nova encerrada, zero routing_requested; controle (upsert normal): aberta, um", () => {
    const hist = upsert("fn_upsert_wa_conversation_do_historico", C_HIST);
    expect(status(hist)).toBe("closed");
    expect(roteamentos(hist)).toBe(0);
    const vivo = upsert("fn_upsert_wa_conversation", C_VIVO);
    expect(status(vivo)).toBe("open");
    expect(roteamentos(vivo)).toBe(1);
  });

  it("conversa que já existe não muda de status pela variante do histórico", () => {
    expect(upsert("fn_upsert_wa_conversation_do_historico", GOV_CONTACT_1)).toBe(GOV_CONV_UNASSIGNED);
    expect(status(GOV_CONV_UNASSIGNED)).toBe("open");
  });

  it("mensagem REAL depois reabre a conversa importada e a põe na fila, como hoje", () => {
    const hist = upsert("fn_upsert_wa_conversation_do_historico", C_HIST);
    sql(`insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id, direction, status, type, body, external_id, sent_at, metadata)
         values ('${GOV_ORG}', '${hist}', '${GOV_SESSION}', '${C_HIST}', 'inbound', 'delivered', 'text', 'velha', 'wamid.HIST-C', now() - interval '60 days', '{"importada_do_historico": true}');`);
    expect(status(hist)).toBe("closed");
    sql(`insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id, direction, status, type, body, external_id, sent_at, metadata)
         values ('${GOV_ORG}', '${hist}', '${GOV_SESSION}', '${C_HIST}', 'inbound', 'delivered', 'text', 'voltei', 'wamid.VIVA-C', now(), '{}');`);
    expect(status(hist)).toBe("open");
    expect(roteamentos(hist)).toBe(1);
  });

  it("a variante é só do service_role", () => {
    expect(sql(`select coalesce(string_agg(r, ','), '') from unnest(array['anon','authenticated','public','service_role']) r
                where has_function_privilege(r, 'public.fn_upsert_wa_conversation_do_historico(uuid,uuid,uuid)', 'execute')`).trim()).toBe("service_role");
  });
});
