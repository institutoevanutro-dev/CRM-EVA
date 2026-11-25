import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, GOV_SESSION, lastLine, seedGov, sql } from "./gov-helpers";

/**
 * 0437 (porte do upstream #5163, 9470 lá) — `lead.won` e `lead.lost` alcançam a
 * origem do atendimento.
 *
 * O gatilho de `crm_leads` emite o desfecho por `fn_log_event`, que deriva a
 * entidade do prefixo do tipo: a linha nasce com `entity_kind='lead'`. Sem o par
 * em `fn_service_event_contact`, o `emit_event` não carimbava `service_origin` e
 * `fn_service_event_origin` recusava com `service_event_origin_unsupported`
 * (`PT409`): a ação de WhatsApp da regra "Quando um negócio for ganho" terminava
 * em origem velha e nada saía.
 *
 * O caminho medido é o de verdade: o negócio vai para a etapa de ganho (ou de
 * perda) e o GATILHO emite o evento.
 *
 * ─── SABOTAGEM ──────────────────────────────────────────────────────────────
 *   - tirar o ramo de won/lost de `fn_service_event_contact`: os quatro pares e
 *     os dois caminhos reais ficam vermelhos.
 *   - deixar só `crm_lead` no ramo: o par com `lead` e os caminhos reais ficam
 *     vermelhos (é a grafia que o gatilho grava).
 */

// Contato, conversa e funil próprios: os do seed são mexidos por outros arquivos.
const CONTATO = "cccccccc-3333-4000-8000-000000000437";
const CONVERSA = "cccccccc-4444-4000-8000-000000000437";
const FUNIL = "cccccccc-5555-4000-8000-000000000437";
const ABERTA = "cccccccc-5555-4000-8000-000000004371";
const GANHO = "cccccccc-5555-4000-8000-000000004372";
const PERDA = "cccccccc-5555-4000-8000-000000004373";
const NEGOCIO_GANHO = "cccccccc-6666-4000-8000-000000004371";
const NEGOCIO_PERDIDO = "cccccccc-6666-4000-8000-000000004372";

function par(tipo: string, entidade: string, id: string): { contact_id: string | null; suportado: boolean } {
  const linha = lastLine(
    sql(`select coalesce(contact_id::text, '') || '|' || suportado::text
           from public.fn_service_event_contact('${GOV_ORG}'::uuid, '${tipo}', '${entidade}', '${id}'::uuid);`),
  );
  const [contato, suportado] = linha.split("|");
  return { contact_id: contato === "" ? null : (contato ?? null), suportado: suportado === "true" };
}

/** O evento que o gatilho acabou de gravar para o negócio. */
function eventoDoGatilho(tipo: string, negocio: string): { id: string; entidade: string; carimbado: string } {
  const [id, entidade, carimbado] = lastLine(
    sql(`select id || '|' || entity_kind || '|' || (payload ? 'service_origin')::text
           from public.event_log
          where organization_id = '${GOV_ORG}' and event_type = '${tipo}' and entity_id = '${negocio}'
          order by created_at desc limit 1;`),
  ).split("|");
  return { id: id ?? "", entidade: entidade ?? "", carimbado: carimbado ?? "" };
}

function conversaDaOrigem(eventoId: string): string | undefined {
  const fronteira = JSON.parse(
    lastLine(
      sql(`select public.fn_service_event_origin('${GOV_ORG}'::uuid, '${eventoId}'::uuid,
        '${CONTATO}'::uuid, '${GOV_SESSION}'::uuid);`),
    ),
  ) as { conversation_id?: string };
  return fronteira.conversation_id;
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO}', '${GOV_ORG}', 'Desfecho do negócio #5077')
      on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONVERSA}', '${GOV_ORG}', '${CONTATO}', '${GOV_SESSION}', 'open')
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${FUNIL}', '${GOV_ORG}', 'Desfecho 0437', 'desfecho-0437')
      on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position, is_won, is_lost) values
      ('${ABERTA}', '${GOV_ORG}', '${FUNIL}', 'Novo', 'novo', 1000, false, false),
      ('${GANHO}', '${GOV_ORG}', '${FUNIL}', 'Ganho', 'ganho', 2000, true, false),
      ('${PERDA}', '${GOV_ORG}', '${FUNIL}', 'Perdido', 'perdido', 3000, false, true)
      on conflict do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, contact_id) values
      ('${NEGOCIO_GANHO}', '${GOV_ORG}', '${FUNIL}', '${ABERTA}', 'Negócio que será ganho', '${CONTATO}'),
      ('${NEGOCIO_PERDIDO}', '${GOV_ORG}', '${FUNIL}', '${ABERTA}', 'Negócio que será perdido', '${CONTATO}')
      on conflict do nothing;
  `);
});

describe("0437 (9470 no original) — lead.won e lead.lost alcançam a origem (#5077)", () => {
  it("lead.won e lead.lost resolvem o contato nas duas grafias de entidade", () => {
    for (const tipo of ["lead.won", "lead.lost"]) {
      for (const entidade of ["lead", "crm_lead"]) {
        expect(par(tipo, entidade, NEGOCIO_GANHO), `${tipo}/${entidade} não resolveu`).toEqual({
          contact_id: CONTATO,
          suportado: true,
        });
      }
    }
  });

  it("caminho real do ganho: o gatilho grava lead.won com entity_kind 'lead', carimbado, e a fronteira resolve a conversa", () => {
    sql(`update public.crm_leads set stage_id = '${GANHO}' where id = '${NEGOCIO_GANHO}';`);
    const evento = eventoDoGatilho("lead.won", NEGOCIO_GANHO);
    expect(evento.entidade).toBe("lead");
    expect(evento.carimbado, "o emit_event não carimbou service_origin no lead.won").toBe("true");
    // Sem o conserto: service_event_origin_unsupported (PT409).
    expect(conversaDaOrigem(evento.id)).toBe(CONVERSA);
  });

  it("caminho real da perda: o gatilho grava lead.lost carimbado, e a fronteira resolve a conversa", () => {
    sql(`update public.crm_leads set stage_id = '${PERDA}', lost_reason = 'price' where id = '${NEGOCIO_PERDIDO}';`);
    const evento = eventoDoGatilho("lead.lost", NEGOCIO_PERDIDO);
    expect(evento.entidade).toBe("lead");
    expect(evento.carimbado, "o emit_event não carimbou service_origin no lead.lost").toBe("true");
    expect(conversaDaOrigem(evento.id)).toBe(CONVERSA);
  });

  it("LADO OPOSTO: lead.reopened e lead.assigned seguem fora, e o que já funcionava continua", () => {
    expect(par("lead.reopened", "lead", NEGOCIO_GANHO).suportado).toBe(false);
    expect(par("lead.assigned", "lead", NEGOCIO_GANHO).suportado).toBe(false);
    // `lead.created` continua só com `crm_lead`: o ramo novo não afrouxa os outros.
    expect(par("lead.created", "crm_lead", NEGOCIO_GANHO)).toEqual({ contact_id: CONTATO, suportado: true });
    expect(par("lead.created", "lead", NEGOCIO_GANHO).suportado).toBe(false);
  });
});
