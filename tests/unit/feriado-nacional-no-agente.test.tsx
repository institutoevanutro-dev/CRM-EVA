/**
 * O agente sabe que é feriado nacional, e pode não atender nele (porte do
 * upstream DeskcommCRM #3894 e #4469, que absorveu o #4169).
 *
 *   1. O bloco do turno diz se hoje/amanhã é feriado, na data do FUSO da clínica.
 *   2. "Não atender em feriado nacional" vem DESLIGADA; ligada, o turno espera a
 *      próxima abertura que não é feriado (Carnaval são dois dias).
 *   3. Ligada, o aviso de fora do horário sai mesmo dentro da janela semanal.
 *   4. A opção sobrevive ao Zod da rota e aparece na tela, desligada.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { TriggerEditor, type TriggerValue } from "@/app/app/ai/agents/[id]/_components/TriggerEditor";
import {
  enviaAvisoForaDoHorario,
  type PortasDoAviso,
} from "@/lib/agent-engine/agent/aviso-fora-do-horario";
import { blocoDoFeriado, ehFeriadoNacionalNoFuso, feriadoNacionalNoTurno } from "@/lib/agent-engine/agent/feriado-nacional";
import {
  lerFechadoEmFeriadoNacional,
  msAteAJanelaAbrir,
  msAteAJanelaAbrirPulandoFeriado,
  type JanelaDeAtendimento,
} from "@/lib/agent-engine/agent/janela-de-atendimento";
import { parseVersionPatch } from "@/lib/ai/agents/validation";

afterEach(cleanup);

const SP = "America/Sao_Paulo";
const JANELA: JanelaDeAtendimento = { timezone: SP, start: "08:00", end: "18:00", weekdays: [1, 2, 3, 4, 5] };
const ehFeriado = (i: Date) => ehFeriadoNacionalNoFuso(i, SP);
const H = 3_600_000;

/** Finados, segunda 02/11/2026, 10:00 em São Paulo. */
const FINADOS_10H = new Date("2026-11-02T13:00:00Z");

describe("o fato do feriado no turno", () => {
  it("Finados: hoje é feriado, e o bloco manda não prometer atendimento", () => {
    const f = feriadoNacionalNoTurno(FINADOS_10H, SP);
    expect(f).toEqual({ hojeEm: "2026-11-02", amanhaEm: "2026-11-03", hoje: true, amanha: false });
    const bloco = blocoDoFeriado(f);
    expect(bloco).toContain("## Feriado nacional");
    expect(bloco).toContain("Hoje (02/11/2026) é feriado nacional no Brasil.");
    expect(bloco).toContain("Não diga que a clínica atende hoje");
  });

  it("às 21h30 de Finados em São Paulo (já dia 03 em UTC) ainda é Finados", () => {
    expect(feriadoNacionalNoTurno(new Date("2026-11-03T00:30:00Z"), SP).hoje).toBe(true);
  });

  it("véspera avisa sobre amanhã; dia comum traz a negativa explícita", () => {
    expect(blocoDoFeriado(feriadoNacionalNoTurno(new Date("2026-11-01T15:00:00Z"), SP))).toContain(
      "Amanhã (02/11/2026) é feriado nacional no Brasil.",
    );
    expect(blocoDoFeriado(feriadoNacionalNoTurno(new Date("2026-11-10T15:00:00Z"), SP))).toBe(
      "## Feriado nacional\nHoje (10/11/2026) e amanhã (11/11/2026) NÃO são feriados nacionais no Brasil.",
    );
  });
});

describe("não atender em feriado nacional: a espera", () => {
  it("Finados 10h ⇒ terça 08:00 (22h), quando a janela semanal diria 'aberta'", () => {
    expect(msAteAJanelaAbrir(JANELA, FINADOS_10H)).toBeNull();
    expect(msAteAJanelaAbrirPulandoFeriado(JANELA, FINADOS_10H, ehFeriado)).toBe(22 * H);
  });

  it("véspera (domingo 20h) ⇒ pula a segunda feriado e espera terça 08:00", () => {
    expect(msAteAJanelaAbrirPulandoFeriado(JANELA, new Date("2026-11-01T23:00:00Z"), ehFeriado)).toBe(36 * H);
  });

  it("Carnaval 2027 (segunda e terça) ⇒ quarta 08:00", () => {
    expect(msAteAJanelaAbrirPulandoFeriado(JANELA, new Date("2027-02-08T13:00:00Z"), ehFeriado)).toBe(46 * H);
  });

  it("dia útil: idêntica à janela semanal", () => {
    const terca = new Date("2026-11-10T13:00:00Z");
    expect(msAteAJanelaAbrirPulandoFeriado(JANELA, terca, ehFeriado)).toBeNull();
    const noite = new Date("2026-11-11T01:00:00Z");
    expect(msAteAJanelaAbrirPulandoFeriado(JANELA, noite, ehFeriado)).toBe(msAteAJanelaAbrir(JANELA, noite));
  });

  it("a opção vem DESLIGADA: só `true` liga", () => {
    expect(lerFechadoEmFeriadoNacional(null)).toBe(false);
    expect(lerFechadoEmFeriadoNacional({ filters: { business_hours: {} } })).toBe(false);
    expect(lerFechadoEmFeriadoNacional({ filters: { business_hours: { fechado_em_feriado_nacional: "sim" } } })).toBe(false);
    expect(lerFechadoEmFeriadoNacional({ filters: { business_hours: { fechado_em_feriado_nacional: true } } })).toBe(true);
  });

  it("o Zod da rota preserva a opção", () => {
    const parsed = parseVersionPatch({
      trigger_config: {
        filters: {
          business_hours: { timezone: SP, start: "08:00", end: "18:00", weekdays: [1, 2, 3, 4, 5], fechado_em_feriado_nacional: true },
        },
      },
    });
    expect(parsed.success).toBe(true);
    expect(lerFechadoEmFeriadoNacional(parsed.data?.trigger_config)).toBe(true);
  });
});

describe("o aviso de fora do horário no feriado", () => {
  function portas() {
    const enviadas: string[] = [];
    const deps: PortasDoAviso = {
      leContato: async () => ({ isBlocked: false, forceHuman: false, isAnonymized: false, isHidden: false, phoneNumber: "+5527999990000" }),
      ehNumeroInterno: async () => false,
      leConversa: async () => ({ ehGrupo: false, ultimaMensagemDoCliente: "Bom dia, tem horário hoje?" }),
      jaAvisado: async () => false,
      pacing: { decide: async () => ({ liberado: true }), registraEnvio: async () => undefined },
      envia: async (e) => void enviadas.push(e.body),
    };
    return { deps, enviadas };
  }
  const entrada = {
    organizationId: "org-1",
    conversationId: "conv-1",
    contactId: "lead-1",
    channelSessionId: "cs-1",
    texto: "Recebemos sua mensagem e respondemos no próximo horário de atendimento.",
    janela: JANELA,
    agora: FINADOS_10H,
  };

  it("dentro da janela num feriado com a opção ligada ⇒ o aviso sai", async () => {
    const { deps, enviadas } = portas();
    expect(await enviaAvisoForaDoHorario(deps, { ...entrada, ehFeriadoNacional: true })).toMatchObject({ enviar: true });
    expect(enviadas).toEqual([entrada.texto]);
  });

  it("sem a opção (fato ausente) ⇒ dentro da janela, nada sai", async () => {
    const { deps, enviadas } = portas();
    expect(await enviaAvisoForaDoHorario(deps, entrada)).toEqual({ enviar: false, motivo: "dentro_da_janela" });
    expect(enviadas).toEqual([]);
  });
});

describe("a tela do agente", () => {
  const valor: TriggerValue = {
    events: ["message"],
    filters: {
      ignore_groups: true,
      ignore_self: true,
      keyword_regex: null,
      business_hours: { timezone: SP, start: "08:00", end: "18:00", weekdays: [1, 2, 3, 4, 5], notice: "Oi" },
    },
    concurrency: "one_per_conversation",
  };

  it("a opção aparece desligada e, ligada, grava a chave sem mexer no resto", () => {
    const onChange = vi.fn();
    render(<TriggerEditor value={valor} onChange={onChange} />);
    const chave = screen.getByRole("switch", { name: "Não atender em feriado nacional" });
    expect(chave.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(chave);
    expect(onChange).toHaveBeenCalledWith({
      ...valor,
      filters: { ...valor.filters, business_hours: { ...valor.filters.business_hours, fechado_em_feriado_nacional: true } },
    });
  });
});
