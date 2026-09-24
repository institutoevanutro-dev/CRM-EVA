/**
 * O HORÁRIO DE ENVIO DOS FOLLOW-UPS tem porta.
 *
 * `settings.followups.bloqueios.janela` era respeitada pelo executor desde a
 * migration 0265 e escrita por ninguém: sem tela, um lead que parava de
 * responder às 20h recebia a primeira mensagem às 23h. Aqui se guarda a regra de
 * escrita que a tela usa — e que ela conversa com a regra de LEITURA do envio,
 * não com uma cópia.
 */
import { describe, expect, it } from "vitest";

import {
  dentroDaJanela,
  janelaDaTelaSchema,
  lerConfigDosBloqueios,
  proximaAbertura,
  settingsComJanela,
} from "@/lib/followup/bloqueios-obrigatorios";

const TZ = "America/Sao_Paulo";
const OITO_AS_21 = { dias: [0, 1, 2, 3, 4, 5, 6], intervalos: [{ inicio: "08:00", fim: "21:00" }] };

describe("horário de envio dos follow-ups", () => {
  it("o que a tela grava é o que o envio lê, no fuso da organização", () => {
    const cfg = lerConfigDosBloqueios(settingsComJanela({}, OITO_AS_21, TZ));
    expect(cfg?.janela).toEqual({ timezone: TZ, ...OITO_AS_21 });

    // 23h em São Paulo (02:00Z do dia seguinte): fora — e adia para as 8h.
    const vinteTresHoras = new Date("2026-09-24T02:00:00Z");
    expect(dentroDaJanela(cfg!.janela!, vinteTresHoras)).toBe(false);
    expect(proximaAbertura(cfg!.janela!, vinteTresHoras)?.toISOString()).toBe("2026-09-24T11:00:00.000Z");
  });

  it("trocar a janela não apaga os outros bloqueios nem as outras chaves", () => {
    const atual = {
      routing: { mode: "round_robin" },
      followups: { outra: 1, bloqueios: { janela: null, uma_sequencia_por_contato: true } },
    };
    const proximo = settingsComJanela(atual, OITO_AS_21, TZ);

    expect(proximo.routing).toEqual({ mode: "round_robin" });
    expect((proximo.followups as { outra: number }).outra).toBe(1);
    expect(lerConfigDosBloqueios(proximo)?.uma_sequencia_por_contato).toBe(true);
  });

  it("desligar grava janela nula: envia a qualquer hora", () => {
    const ligado = settingsComJanela({}, OITO_AS_21, TZ);
    expect(lerConfigDosBloqueios(settingsComJanela(ligado, null, TZ))?.janela).toBeNull();
  });

  it("bloqueios ilegíveis — que calam todo envio — são consertados ao salvar", () => {
    const quebrado = { followups: { bloqueios: { janela: "sempre" } } };
    expect(lerConfigDosBloqueios(quebrado)).toBeNull();
    expect(lerConfigDosBloqueios(settingsComJanela(quebrado, OITO_AS_21, TZ))?.janela?.timezone).toBe(TZ);
  });

  it("a tela não escolhe o fuso, nem manda janela impossível", () => {
    expect(janelaDaTelaSchema.safeParse({ ...OITO_AS_21, timezone: "UTC" }).success).toBe(false);
    expect(janelaDaTelaSchema.safeParse({ dias: [1], intervalos: [{ inicio: "21:00", fim: "08:00" }] }).success).toBe(false);
    expect(janelaDaTelaSchema.safeParse({ dias: [], intervalos: [{ inicio: "08:00", fim: "21:00" }] }).success).toBe(false);
    expect(janelaDaTelaSchema.safeParse(null).success).toBe(true);
  });
});
