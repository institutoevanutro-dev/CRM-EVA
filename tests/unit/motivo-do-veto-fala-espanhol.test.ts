/**
 * O MOTIVO DO VETO NA LINHA DO TEMPO FALA ESPANHOL.
 *
 * `vetoReason` grava o texto em `crm_lead_activities.reason`, e a tela o traduz na
 * LEITURA (`t(item.reason)` em LeadTimeline e CRMSidePanel). O gate de i18n
 * (`tests/unit/i18n-espanhol-cobre-a-tela.test.ts`) não enxerga esse caminho: o
 * texto não passa por `t()` onde nasce. O porte do #3596 acrescentou o motivo do
 * `horario_da_agenda` sem a chave no dicionário, e quem usa a tela em espanhol lia
 * o aviso do Inbox em espanhol e a linha do mesmo veto em português.
 */
import { describe, expect, it } from "vitest";

import { traduzir } from "@/lib/i18n/dicionario";
import { MOTIVO_DO_VETO_POR_GATE, vetoReason } from "@/lib/leads/veto-activity";

describe("o motivo do veto, gravado em português, é traduzido na leitura", () => {
  it.each(Object.entries(MOTIVO_DO_VETO_POR_GATE))("%s tem a chave em espanhol", (_gate, motivo) => {
    const es = traduzir(motivo, "es");
    expect(es, "sem chave no dicionário: a tela em espanhol mostra o português").not.toBe(motivo);
    expect(es.startsWith("No envié:")).toBe(true);
  });

  it("o do horário da agenda (porte do #3596) é o que a linha do tempo grava", () => {
    expect(traduzir(vetoReason("horario_da_agenda", "horario_sem_fonte"), "es")).toContain("la agenda no devolvió");
  });
});
