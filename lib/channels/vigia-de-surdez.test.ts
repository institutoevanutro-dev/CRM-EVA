import { describe, expect, it } from "vitest";

import {
  CHAVE_DO_VIGIA,
  SURDEZ_ESPERA_DO_AVISO_MS,
  SURDEZ_FOLGA_DO_REINICIO_MS,
  SURDEZ_JANELA_MAXIMA_MS,
  SURDEZ_SILENCIO_MINIMO_MS,
  TETO_PADRAO,
  avisoDeSurdez,
  avisoDeSurdezSemEfeito,
  avisoDeVoltaDaSurdez,
  avisoPendenteDoVigia,
  decidirVigiaDeSurdez,
  ehAvisoDoVigiaDeSurdez,
  precisaPerguntarSeEntrou,
  relogioDoVigia,
  tetoDosReinicios,
} from "./vigia-de-surdez";

/**
 * "WORKING, mas surda": medido em produção em 10/10/2026 e de novo em outubro,
 * quando o único reinício automático não resolveu e o número ficou ~15 h sem
 * receber. Estes casos prendem QUANDO o vigia religa, quantas vezes, quando ele
 * desiste e chama gente, e quando ele diz que voltou.
 */
const AGORA = new Date("2026-10-10T15:00:00.000Z");
const ha = (ms: number) => new Date(AGORA.getTime() - ms).toISOString();
const MIN = 60_000;
const HORA = 60 * MIN;

const base = {
  status: "WORKING",
  lastStatusChangeAt: ha(60 * MIN),
  metadata: {},
  houveEntrada: false,
  agora: AGORA,
  teto: TETO_PADRAO,
};
const marca = (m: Record<string, unknown>) => ({ ai_gate: { on: true }, [CHAVE_DO_VIGIA]: m });

describe("decidirVigiaDeSurdez: a primeira tentativa", () => {
  it("as janelas são as combinadas: 45 min, 6 h, 5 min de folga e 2 reinícios em 6 h", () => {
    expect(SURDEZ_SILENCIO_MINIMO_MS).toBe(45 * MIN);
    expect(SURDEZ_JANELA_MAXIMA_MS).toBe(6 * HORA);
    expect(SURDEZ_FOLGA_DO_REINICIO_MS).toBe(5 * MIN);
    expect(TETO_PADRAO).toEqual({ maximo: 2, janelaMs: 6 * HORA });
  });

  it("religa: WORKING, mudou há 1 h e nada entrou desde então", () => {
    expect(decidirVigiaDeSurdez(base)).toEqual({ acao: "reiniciar", quedaEm: ha(60 * MIN), tentativa: 1 });
  });

  it("saudável: entrou mensagem depois da mudança", () => {
    expect(decidirVigiaDeSurdez({ ...base, houveEntrada: true })).toEqual({ acao: "nada", motivo: "saudavel" });
  });

  it("recente demais: menos de 45 min de silêncio não prova nada (inclui quem acabou de reconectar à mão)", () => {
    expect(decidirVigiaDeSurdez({ ...base, lastStatusChangeAt: ha(44 * MIN) })).toEqual({
      acao: "nada",
      motivo: "recente",
    });
  });

  it("antiga demais: depois de 6 h é madrugada ou canal parado, não surdez", () => {
    expect(decidirVigiaDeSurdez({ ...base, lastStatusChangeAt: ha(6 * HORA + 1) })).toEqual({
      acao: "nada",
      motivo: "antiga",
    });
  });

  it("não está WORKING: QR pendente, queda e boot têm outro dono", () => {
    for (const status of ["STARTING", "SCAN_QR_CODE", "FAILED", "STOPPED", null]) {
      expect(decidirVigiaDeSurdez({ ...base, status }), String(status)).toEqual({
        acao: "nada",
        motivo: "nao_working",
      });
    }
  });

  it("sem data de mudança não há de onde contar o silêncio", () => {
    expect(decidirVigiaDeSurdez({ ...base, lastStatusChangeAt: null })).toEqual({ acao: "nada", motivo: "sem_data" });
  });

  it("metadata torta não derruba nem trava", () => {
    for (const metadata of [null, "x", [], { [CHAVE_DO_VIGIA]: "x" }, { [CHAVE_DO_VIGIA]: { reiniciado_em: "ontem" } }]) {
      expect(decidirVigiaDeSurdez({ ...base, metadata }).acao, JSON.stringify(metadata)).toBe("reiniciar");
    }
  });
});

describe("decidirVigiaDeSurdez: depois do reinício", () => {
  // Queda há 2 h; os eventos do reinício movem a data 20 s depois dele.
  const queda = ha(2 * HORA);
  const depoisDoReinicio = (reinicioHa: number, extra: Record<string, unknown> = {}) => ({
    ...base,
    lastStatusChangeAt: ha(reinicioHa - 20_000),
    metadata: marca({ versao: 1, reiniciado_em: ha(reinicioHa), reinicios: [ha(reinicioHa)], queda_em: queda, ...extra }),
  });

  it("aguarda: menos de 45 min depois do próprio reinício não se tenta de novo", () => {
    expect(decidirVigiaDeSurdez(depoisDoReinicio(10 * MIN))).toEqual({ acao: "nada", motivo: "aguardando" });
  });

  it("voltou: entrou mensagem depois do reinício, e isso vale aviso, não silêncio", () => {
    expect(decidirVigiaDeSurdez({ ...depoisDoReinicio(10 * MIN), houveEntrada: true })).toEqual({
      acao: "voltou",
      quedaEm: queda,
    });
  });

  it("não resolveu: 45 min depois do reinício e ainda nada, tenta a segunda vez", () => {
    expect(decidirVigiaDeSurdez(depoisDoReinicio(50 * MIN))).toEqual({
      acao: "reiniciar",
      quedaEm: queda,
      tentativa: 2,
    });
  });

  it("reinício que FALHOU e nem moveu a data: o relógio conta do reinício, não da queda", () => {
    const entrada = {
      ...base,
      lastStatusChangeAt: queda,
      metadata: marca({ versao: 1, reiniciado_em: ha(10 * MIN), reinicios: [ha(10 * MIN)], queda_em: queda, falhou: true }),
    };
    expect(decidirVigiaDeSurdez(entrada)).toEqual({ acao: "nada", motivo: "aguardando" });
  });

  it("teto: dois reinícios em 6 h e nada voltou → desiste e chama gente, uma vez", () => {
    const entrada = {
      ...base,
      lastStatusChangeAt: ha(50 * MIN - 20_000),
      metadata: marca({ versao: 2, reiniciado_em: ha(50 * MIN), reinicios: [ha(95 * MIN), ha(50 * MIN)], queda_em: queda }),
    };
    expect(decidirVigiaDeSurdez(entrada)).toEqual({ acao: "escalar", quedaEm: queda, tentativas: 2, recentes: 2 });

    const escalado = {
      ...entrada,
      metadata: marca({ versao: 3, reiniciado_em: ha(50 * MIN), reinicios: [ha(95 * MIN), ha(50 * MIN)], queda_em: queda, desfecho: "escalado" }),
    };
    expect(decidirVigiaDeSurdez(escalado)).toEqual({ acao: "nada", motivo: "escalado" });
    // ...mas se as mensagens voltarem depois do aviso, isso também é dito.
    expect(decidirVigiaDeSurdez({ ...escalado, houveEntrada: true })).toEqual({ acao: "voltou", quedaEm: queda });
  });

  it("episódio que voltou está encerrado: só uma queda NOVA rearma", () => {
    const encerrado = depoisDoReinicio(60 * MIN, { desfecho: "voltou" });
    expect(decidirVigiaDeSurdez(encerrado)).toEqual({ acao: "nada", motivo: "encerrado" });
    expect(decidirVigiaDeSurdez({ ...encerrado, houveEntrada: true })).toEqual({ acao: "nada", motivo: "encerrado" });

    const quedaNova = { ...encerrado, lastStatusChangeAt: ha(50 * MIN) };
    expect(decidirVigiaDeSurdez(quedaNova)).toEqual({ acao: "reiniciar", quedaEm: ha(50 * MIN), tentativa: 1 });
  });

  it("depois de 6 h da queda o episódio não rende mais reinício: se houve tentativa sem volta, chama gente", () => {
    const entrada = {
      ...base,
      lastStatusChangeAt: ha(50 * MIN - 20_000),
      metadata: marca({ versao: 1, reiniciado_em: ha(50 * MIN), reinicios: [ha(50 * MIN)], queda_em: ha(6 * HORA + 30 * MIN) }),
    };
    expect(decidirVigiaDeSurdez(entrada)).toMatchObject({ acao: "escalar", tentativas: 1 });
  });

  it("teto vale entre quedas: o número que cai e emudece toda hora não vira laço", () => {
    // Já reiniciou duas vezes nas últimas 6 h por quedas anteriores; cai de novo.
    const entrada = {
      ...base,
      metadata: marca({ versao: 4, reiniciado_em: ha(2 * HORA), reinicios: [ha(4 * HORA), ha(2 * HORA)], queda_em: ha(5 * HORA), desfecho: "voltou" }),
    };
    expect(decidirVigiaDeSurdez(entrada)).toEqual({ acao: "escalar", quedaEm: ha(60 * MIN), tentativas: 0, recentes: 2 });
    // O reinício mais velho saiu da janela: volta a poder.
    const depois = {
      ...entrada,
      metadata: marca({ versao: 4, reiniciado_em: ha(2 * HORA), reinicios: [ha(6 * HORA + MIN), ha(2 * HORA)], queda_em: ha(5 * HORA) }),
    };
    expect(decidirVigiaDeSurdez(depois)).toMatchObject({ acao: "reiniciar", tentativa: 1 });
  });

  it("escalado sem reinício (teto) também é lembrado: não repete o aviso a cada rodada", () => {
    const entrada = {
      ...base,
      metadata: marca({ versao: 5, reiniciado_em: ha(2 * HORA), reinicios: [ha(4 * HORA), ha(2 * HORA)], queda_em: ha(60 * MIN), desfecho: "escalado" }),
    };
    expect(decidirVigiaDeSurdez(entrada)).toEqual({ acao: "nada", motivo: "escalado" });
  });

  it("teto 0 desliga o reinício: o vigia só avisa", () => {
    expect(decidirVigiaDeSurdez({ ...base, teto: { maximo: 0, janelaMs: 6 * HORA } })).toEqual({
      acao: "escalar",
      quedaEm: ha(60 * MIN),
      tentativas: 0,
      recentes: 0,
    });
  });

  it("marca da versão anterior (sem lista, sem queda, sem versão) segue valendo", () => {
    const antiga = {
      ...base,
      lastStatusChangeAt: ha(50 * MIN - 20_000),
      metadata: { [CHAVE_DO_VIGIA]: { reiniciado_em: ha(50 * MIN) } },
    };
    expect(decidirVigiaDeSurdez(antiga)).toEqual({ acao: "reiniciar", quedaEm: ha(50 * MIN), tentativa: 2 });
  });
});

describe("o que a rota pergunta ao banco", () => {
  it("só consulta mensagens quando há o que decidir", () => {
    expect(precisaPerguntarSeEntrou({ acao: "reiniciar", quedaEm: "x", tentativa: 1 })).toBe(true);
    expect(precisaPerguntarSeEntrou({ acao: "escalar", quedaEm: "x", tentativas: 1, recentes: 1 })).toBe(true);
    expect(precisaPerguntarSeEntrou({ acao: "nada", motivo: "aguardando" })).toBe(true);
    expect(precisaPerguntarSeEntrou({ acao: "nada", motivo: "escalado" })).toBe(true);
    for (const motivo of ["nao_working", "sem_data", "recente", "antiga", "encerrado", "saudavel"] as const) {
      expect(precisaPerguntarSeEntrou({ acao: "nada", motivo }), motivo).toBe(false);
    }
  });

  it("o relógio é a queda, ou o último reinício quando ele é mais novo", () => {
    expect(relogioDoVigia(ha(60 * MIN), {})).toBe(ha(60 * MIN));
    expect(relogioDoVigia(ha(60 * MIN), marca({ reiniciado_em: ha(10 * MIN), queda_em: ha(60 * MIN) }))).toBe(ha(10 * MIN));
    expect(relogioDoVigia(null, {})).toBeNull();
  });
});

describe("tetoDosReinicios: o knob do .env", () => {
  it("vazio ou lixo cai no padrão, sem derrubar nada", () => {
    for (const lixo of [undefined, "", " ", "dois", "-1", "2.5", "99"]) {
      expect(tetoDosReinicios(lixo, lixo), String(lixo)).toEqual(TETO_PADRAO);
    }
  });

  it("valores válidos valem, e 0 reinícios é desligar", () => {
    expect(tetoDosReinicios("3", "12")).toEqual({ maximo: 3, janelaMs: 12 * HORA });
    expect(tetoDosReinicios("0", "")).toEqual({ maximo: 0, janelaMs: 6 * HORA });
  });
});

describe("avisos do vigia", () => {
  const relogio = { fuso: "America/Sao_Paulo", idioma: "pt-BR" as const, agora: AGORA };

  it("fica pendente até os eventos do reinício assentarem, e sai uma vez só", () => {
    const m = (reiniciadoHa: number, extra = {}) => ({ [CHAVE_DO_VIGIA]: { reiniciado_em: ha(reiniciadoHa), ...extra } });
    expect(avisoPendenteDoVigia({}, AGORA)).toBe(false);
    expect(avisoPendenteDoVigia(m(SURDEZ_ESPERA_DO_AVISO_MS - 1), AGORA)).toBe(false);
    expect(avisoPendenteDoVigia(m(SURDEZ_ESPERA_DO_AVISO_MS), AGORA)).toBe(true);
    expect(avisoPendenteDoVigia(m(10 * MIN, { avisado_em: ha(5 * MIN) }), AGORA)).toBe(false);
  });

  it("reinício: diz QUAL conexão, a hora do reinício e da queda, no fuso da organização", () => {
    const a = avisoDeSurdez({
      apelido: "Recepção",
      falhou: false,
      reiniciadoEm: "2026-10-10T12:40:00.000Z",
      quedaEm: "2026-10-10T06:12:00.000Z",
      tentativa: 1,
      maximo: 2,
      relogio,
    });
    expect(a.title).toBe('WhatsApp "Recepção" ficou sem receber mensagens depois de uma queda');
    expect(a.body).toMatch(/^O CRM reiniciou a conexão sozinho às 09:40/);
    // A hora da queda cabe no corte de 140 caracteres do celular.
    expect(a.body.slice(0, 139)).toMatch(/às 03:12/);
    expect(a.body).toMatch(/Tentativa 1 de 2/);
  });

  it("reinício recusado diz que não conseguiu e manda reconectar", () => {
    const a = avisoDeSurdez({
      apelido: "R",
      falhou: true,
      reiniciadoEm: "2026-10-10T12:40:00.000Z",
      quedaEm: "2026-10-10T06:12:00.000Z",
      tentativa: 1,
      maximo: 2,
      relogio,
    });
    expect(a.body).toMatch(/não conseguiu/);
    expect(a.body).toMatch(/Conexões/);
  });

  it("volta: aponta a janela em que mensagem pode ter se perdido", () => {
    const a = avisoDeVoltaDaSurdez({
      apelido: "Recepção",
      quedaEm: "2026-10-09T23:12:00.000Z",
      reiniciadoEm: "2026-10-10T12:40:00.000Z",
      voltouEm: "2026-10-10T12:43:00.000Z",
      relogio,
    });
    expect(a.title).toBe('WhatsApp "Recepção" voltou a receber mensagens');
    expect(a.body).toMatch(/^Voltou às 09:43\./);
    // A queda foi no dia anterior: a data aparece, para não parecer "hoje às 20:12".
    expect(a.body).toMatch(/entre 09\/10 20:12 e 09:40/);
    expect(a.body).toMatch(/celular/);
  });

  it("sem efeito: o que fazer vem primeiro (é o que cabe no celular) e admite que pode ser só silêncio", () => {
    const a = avisoDeSurdezSemEfeito({
      apelido: "Recepção",
      quedaEm: "2026-10-10T06:12:00.000Z",
      reiniciadoEm: "2026-10-10T12:40:00.000Z",
      tentativas: 2,
      recentes: 2,
      teto: TETO_PADRAO,
      relogio,
    });
    expect(a.title).toBe('WhatsApp "Recepção" continua sem receber mensagens');
    expect(a.body.slice(0, 140)).toMatch(/reconecte em Conexões/i);
    expect(a.body).toMatch(/2 reinícios automáticos/);
    expect(a.body).toMatch(/falta de movimento/);

    const desligado = avisoDeSurdezSemEfeito({
      apelido: "R",
      quedaEm: "2026-10-10T06:12:00.000Z",
      reiniciadoEm: null,
      tentativas: 0,
      recentes: 0,
      teto: { maximo: 0, janelaMs: 6 * HORA },
      relogio,
    });
    expect(desligado.body).toMatch(/desligado/);
  });

  it("texto sem travessão, e o celular reconhece os três títulos e só eles", () => {
    const textos = [
      avisoDeSurdez({ apelido: "R", falhou: false, reiniciadoEm: ha(0), quedaEm: ha(HORA), tentativa: 1, maximo: 2, relogio }),
      avisoDeSurdez({ apelido: "R", falhou: true, reiniciadoEm: ha(0), quedaEm: ha(HORA), tentativa: 1, maximo: 2, relogio }),
      avisoDeVoltaDaSurdez({ apelido: "R", quedaEm: ha(HORA), reiniciadoEm: null, voltouEm: ha(0), relogio }),
      avisoDeSurdezSemEfeito({ apelido: "R", quedaEm: ha(HORA), reiniciadoEm: ha(0), tentativas: 1, recentes: 1, teto: TETO_PADRAO, relogio }),
    ];
    for (const t of textos) {
      expect(t.title + t.body).not.toMatch(/—/);
      expect(ehAvisoDoVigiaDeSurdez(t.title), t.title).toBe(true);
    }
    expect(ehAvisoDoVigiaDeSurdez('WhatsApp "R" fora do ar (STOPPED)')).toBe(false);
    expect(ehAvisoDoVigiaDeSurdez('Não foi possível verificar a conexão "R"')).toBe(false);
    expect(ehAvisoDoVigiaDeSurdez(null)).toBe(false);
  });
});
