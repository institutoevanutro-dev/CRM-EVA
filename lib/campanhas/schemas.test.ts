/**
 * Ritmo: meia janela ou intervalo 0 viram RECUSA LEGÍVEL, não "Erro interno"
 * (auditoria de 17/11/2026, item 18). Antes, só "Enviar a partir das" passava
 * no schema, batia no CHECK `campaigns_janela_check` e voltava como 500.
 */
import { describe, expect, it } from "vitest";

import { criarCampanhaSchema, erroDaJanela, mensagemDaRecusa, ritmoCompletoSchema } from "./schemas";

const BASE = {
  name: "Retorno de pacientes (fictícia)",
  channel_session_id: "33333333-3333-4333-8333-333333333333",
  base_legal: "consent",
};

describe("erroDaJanela", () => {
  it("as duas horas ou nenhuma, e o fim depois do começo", () => {
    expect(erroDaJanela(null, null)).toBeNull();
    expect(erroDaJanela(9, 18)).toBeNull();
    expect(erroDaJanela(9, null)).toBe("Preencha as duas horas, ou deixe as duas em branco.");
    expect(erroDaJanela(undefined, 18)).toBe("Preencha as duas horas, ou deixe as duas em branco.");
    expect(erroDaJanela(18, 9)).toBe("A janela precisa terminar depois de começar.");
  });
});

describe("criar campanha", () => {
  it("só o início da janela é recusado no schema — não chega ao banco", () => {
    const r = criarCampanhaSchema.safeParse({ ...BASE, janela_inicio_hora: 9 });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["janela_fim_hora"]);
    expect(mensagemDaRecusa(r.error!)).toBe("Preencha as duas horas, ou deixe as duas em branco.");
  });

  it("intervalo 0 diz o campo e o mínimo, não só 'Dados inválidos.'", () => {
    const r = criarCampanhaSchema.safeParse({ ...BASE, intervalo_segundos: 0 });
    expect(mensagemDaRecusa(r.error!)).toBe("Use pelo menos 1 segundo.");
  });

  it("erro fora do ritmo continua genérico, com o detalhe por campo", () => {
    const r = criarCampanhaSchema.safeParse({ ...BASE, name: "" });
    expect(mensagemDaRecusa(r.error!)).toBe("Dados inválidos.");
  });
});

describe("ritmoCompletoSchema (o que a tela valida)", () => {
  it("põe o erro da meia janela no campo que falta", () => {
    const r = ritmoCompletoSchema.safeParse({ janela_inicio_hora: null, janela_fim_hora: 20 });
    expect(r.error?.issues[0]?.path).toEqual(["janela_inicio_hora"]);
  });
});
