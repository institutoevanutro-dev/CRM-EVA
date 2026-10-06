/**
 * Porte parcial de `lib/followup/reactivity-dormente.test.ts` do original
 * (f90f236aa). O nome é o do original para facilitar merges futuros; este fork
 * ainda não tem o status `dormente`, então só vêm os casos que medem a guarda
 * do f90f236aa: uma mensagem ANTERIOR ao estacionamento (`updated_at`) não
 * acorda a espera nova — senão o kick que agora acorda antes de aplicar o
 * texto despejaria o fluxo inteiro de uma vez.
 */

import { describe, expect, it } from "vitest";

import {
  applyReactivityEvent,
  type LiveEnrollmentRef,
  type ReactivityAdminClient,
} from "./reactivity";
import type { EnrollmentPatch } from "./engine";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const AGORA = "2026-09-20T19:36:00.000Z";

interface Espiao {
  eventos: Array<{ event_type: string; enrollment_id: string }>;
  patches: Array<{ id: string; patch: EnrollmentPatch }>;
}

function montarDb(inscricoes: LiveEnrollmentRef[]): { db: ReactivityAdminClient; espiao: Espiao } {
  const espiao: Espiao = { eventos: [], patches: [] };
  const db: ReactivityAdminClient = {
    async loadConversationContactId() {
      return CONTATO;
    },
    async loadContactBlocked() {
      return false;
    },
    async loadLiveEnrollmentsForContact() {
      return inscricoes;
    },
    async insertEnrollmentEvent(event) {
      espiao.eventos.push({ event_type: event.event_type, enrollment_id: event.enrollment_id });
      return { inserted: true };
    },
    async updateEnrollment(id, _org, patch) {
      espiao.patches.push({ id, patch });
    },
    async agoraNoBanco() {
      return AGORA;
    },
  };
  return { db, espiao };
}

function inscricao(over: Partial<LiveEnrollmentRef> = {}): LiveEnrollmentRef {
  return {
    id: "enr-1",
    status: "active",
    current_node_id: "w1",
    steps_taken: 3,
    pointer_id: "ptr-1",
    handoff_policy: "pause",
    trigger_config: null,
    ...over,
  };
}

function eventoDeInbound() {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    organization_id: ORG,
    event_type: "message.received",
    payload: { contact_id: CONTATO, direction: "inbound" },
  } as never;
}

describe("reatividade — a mensagem anterior ao estacionamento", () => {
  it("não acorda espera estacionada depois da mensagem", async () => {
    const { db, espiao } = montarDb([
      inscricao({
        status: "waiting_reply",
        updated_at: "2026-09-20T19:35:47.000Z",
      }),
    ]);

    const s = await applyReactivityEvent(db, () => new Date(AGORA), {
      ...eventoDeInbound(),
      created_at: "2026-09-20T19:35:45.000Z",
    });

    expect(s.reacted).toBe(0);
    expect(espiao.eventos).toEqual([]);
    expect(espiao.patches).toEqual([]);
  });

  it("acorda a espera que já existia antes da mensagem (controle)", async () => {
    const { db, espiao } = montarDb([
      inscricao({
        status: "waiting_reply",
        updated_at: "2026-09-20T19:30:00.000Z",
      }),
    ]);

    const s = await applyReactivityEvent(db, () => new Date(AGORA), {
      ...eventoDeInbound(),
      created_at: "2026-09-20T19:35:45.000Z",
    });

    expect(s.reacted).toBe(1);
    expect(espiao.eventos.map((e) => e.event_type)).toEqual(["inbound_woke"]);
  });
});
