import { describe, expect, it } from "vitest";

import {
  IDADE_MAXIMA_PADRAO_HORAS,
  MOTIVO_DA_PAUSA_DE_LIGACAO,
  avaliarRetomadaPorClienteSemResposta,
  ehSoDespedida,
  todasSaoDespedida,
  selecionarClientesSemResposta,
  type ConversaEmPausa,
  type SelecaoDaPausa,
} from "@/lib/escalacao/devolucao-automatica";
import {
  lerClienteSemRespostaMaxHoras,
  lerClienteSemRespostaMin,
  lerPausaPorRespostaHumanaMin,
  settingsComClienteSemResposta,
  settingsComClienteSemRespostaMaxHoras,
} from "@/lib/escalacao/pausa-por-resposta-humana";

/**
 * O CLIENTE QUE ESCREVE DURANTE A PAUSA NÃO FICA HORAS SEM RESPOSTA.
 *
 * Caso real (21/10/2026): recepção respondeu pelo celular às 09:21, pausa de
 * 12 h até 21:21; o paciente escreveu às 15:35 e ninguém respondeu. Com
 * `pausa_cliente_sem_resposta_min = 15`, às 15:50 a IA retoma. E só nesse caso:
 * a equipe respondendo, alguém tendo assumido pelo botão, o contato que pediu
 * humano ou o número sem agente seguram a IA fora.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const SESSAO = "33333333-3333-4333-8333-333333333333";
const AGORA = Date.parse("2026-10-21T15:50:00-03:00");
const min = (n: number) => new Date(AGORA - n * 60_000).toISOString();

function conversa(sobrescreve: Partial<ConversaEmPausa> = {}): ConversaEmPausa {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    organization_id: ORG,
    contact_id: "55555555-5555-4555-8555-555555555555",
    channel_session_id: SESSAO,
    status: "open",
    assignee_kind: "ai",
    assigned_to_user_id: null,
    assigned_at: null,
    // Recepção respondeu às 09:21 (6h29 atrás), pausa de 12 h.
    last_outbound_at: min(389),
    last_handoff_at: min(389),
    last_handoff_reason: "Atendimento manual pelo canal (resposta fora do CRM)",
    bot_silenced_until: new Date(AGORA + 331 * 60_000).toISOString(),
    // Paciente às 15:35.
    last_inbound_at: min(15),
    awaiting_since: min(15),
    status_changed_at: min(400),
    contacts: { is_blocked: false, ai_opt_out: false, force_human: false },
    ...sobrescreve,
  };
}

const sel = (sobrescreve: Partial<SelecaoDaPausa> = {}): SelecaoDaPausa => ({
  esperaPorOrg: new Map([[ORG, 15]]),
  sessoesComAgente: new Map([[ORG, new Set([SESSAO])]]),
  agoraMs: AGORA,
  ...sobrescreve,
});

const motivo = (c: ConversaEmPausa, s = sel()) => {
  const r = avaliarRetomadaPorClienteSemResposta(c, s);
  return r.retomar ? "retoma" : r.motivo;
};

describe("avaliarRetomadaPorClienteSemResposta", () => {
  it("o caso medido: 15 min sem resposta, a IA retoma", () => {
    expect(avaliarRetomadaPorClienteSemResposta(conversa(), sel())).toEqual({ retomar: true, minutos: 15 });
  });

  it("dentro dos N minutos: ainda não", () => {
    expect(motivo(conversa({ last_inbound_at: min(14), awaiting_since: min(14) }))).toBe("dentro_da_espera");
  });

  it("a espera conta da PRIMEIRA mensagem sem resposta, não da última", () => {
    expect(motivo(conversa({ last_inbound_at: min(1), awaiting_since: min(20) }))).toBe("retoma");
  });

  it("awaiting_since de antes da última resposta é passado: vale a última mensagem", () => {
    expect(motivo(conversa({ last_inbound_at: min(10), awaiting_since: min(500) }))).toBe("dentro_da_espera");
  });

  it("a equipe respondeu depois da mensagem do cliente: não retoma", () => {
    expect(motivo(conversa({ last_outbound_at: min(5) }))).toBe("sem_mensagem_pendente");
    expect(motivo(conversa({ last_inbound_at: null }))).toBe("sem_mensagem_pendente");
  });

  it("alguém assumiu pelo botão (humano durável): não retoma", () => {
    expect(motivo(conversa({ bot_silenced_until: "infinity" }))).toBe("humano_duravel");
    expect(motivo(conversa({ assignee_kind: "user" }))).toBe("humano_duravel");
    expect(motivo(conversa({ assigned_to_user_id: "u1" }))).toBe("humano_duravel");
  });

  it("contato bloqueado, 'sempre humano' ou com a trava de humano: não retoma", () => {
    expect(motivo(conversa({ contacts: { is_blocked: true, ai_opt_out: false, force_human: false } }))).toBe(
      "contato_bloqueado",
    );
    expect(motivo(conversa({ contacts: { is_blocked: false, ai_opt_out: true, force_human: true } }))).toBe(
      "contato_sempre_humano",
    );
    expect(motivo(conversa({ contacts: { is_blocked: false, ai_opt_out: false, force_human: true } }))).toBe(
      "contato_com_humano",
    );
  });

  it("ajuste desligado (o padrão): nunca retoma", () => {
    expect(motivo(conversa(), sel({ esperaPorOrg: new Map() }))).toBe("sem_ajuste");
  });

  it("número sem agente que atenda: não retoma", () => {
    expect(motivo(conversa(), sel({ sessoesComAgente: new Map() }))).toBe("sessao_sem_agente");
    expect(motivo(conversa({ channel_session_id: null }))).toBe("sessao_sem_agente");
  });

  it("pausa já vencida ou ausente: não é com esta regra", () => {
    expect(motivo(conversa({ bot_silenced_until: min(1) }))).toBe("sem_pausa_vigente");
    expect(motivo(conversa({ bot_silenced_until: null }))).toBe("sem_pausa_vigente");
  });

  it("ligação de voz em andamento: há uma pessoa falando com o cliente agora", () => {
    expect(motivo(conversa({ last_handoff_reason: MOTIVO_DA_PAUSA_DE_LIGACAO }))).toBe("ligacao_em_andamento");
  });

  it("conversa encerrada: não retoma", () => {
    expect(motivo(conversa({ status: "closed" }))).toBe("status_nao_devolvivel");
  });

  it("selecionar devolve só as que retomam, com os minutos da organização", () => {
    const sim = conversa();
    const nao = conversa({ id: "x", last_outbound_at: min(1) });
    expect(selecionarClientesSemResposta([sim, nao], sel())).toEqual([{ conversa: sim, minutos: 15 }]);
  });
});

describe("lerClienteSemRespostaMin — o ajuste", () => {
  const comEspera = (v: unknown) => ({ atendimento: { pausa_cliente_sem_resposta_min: v } });

  it.each([null, undefined, {}, { atendimento: {} }, "texto", comEspera(null)])(
    "sem o ajuste (%j) fica DESLIGADO: quem não ligou não muda",
    (settings) => {
      expect(lerClienteSemRespostaMin(settings)).toBeNull();
    },
  );

  it("devolve o valor da organização, nas duas pontas da faixa", () => {
    expect(lerClienteSemRespostaMin(comEspera(5))).toBe(5);
    expect(lerClienteSemRespostaMin(comEspera(15))).toBe(15);
    expect(lerClienteSemRespostaMin(comEspera(240))).toBe(240);
  });

  it.each([4, 0, -1, 241, 1440, 7.5, "15", Number.NaN, {}])("valor inválido (%j) é desligado, nunca prazo", (v) => {
    expect(lerClienteSemRespostaMin(comEspera(v))).toBeNull();
  });

  it("gravar troca só a espera e preserva o resto; null desliga", () => {
    const antes = { routing: { mode: "manual" }, atendimento: { pausa_ia_resposta_humana_min: 720 } };
    const depois = settingsComClienteSemResposta(antes, 15);
    expect(depois).toEqual({
      routing: { mode: "manual" },
      atendimento: { pausa_ia_resposta_humana_min: 720, pausa_cliente_sem_resposta_min: 15 },
    });
    expect(lerPausaPorRespostaHumanaMin(depois)).toBe(720);
    expect(lerClienteSemRespostaMin(settingsComClienteSemResposta(depois, null))).toBeNull();
    expect(settingsComClienteSemResposta("lixo", 15)).toEqual({ atendimento: { pausa_cliente_sem_resposta_min: 15 } });
  });
});

describe("teto de idade da mensagem pendente (4.30.0: retomadas de 9 h atrás)", () => {
  it("o padrão é 4 h: mensagem de 5 h atrás não é retomada", () => {
    expect(IDADE_MAXIMA_PADRAO_HORAS).toBe(4);
    expect(motivo(conversa({ last_inbound_at: min(300), awaiting_since: min(300) }))).toBe("pendente_antiga");
  });

  it("dentro do teto (3 h) ainda retoma", () => {
    expect(motivo(conversa({ last_inbound_at: min(180), awaiting_since: min(180) }))).toBe("retoma");
  });

  it("o teto é da organização", () => {
    const c = conversa({ last_inbound_at: min(300), awaiting_since: min(300) });
    expect(motivo(c, sel({ maxHorasPorOrg: new Map([[ORG, 6]]) }))).toBe("retoma");
    expect(motivo(conversa({ last_inbound_at: min(90) }), sel({ maxHorasPorOrg: new Map([[ORG, 1]]) }))).toBe(
      "pendente_antiga",
    );
  });

  it("conta da ÚLTIMA mensagem: quem insiste agora segue elegível", () => {
    expect(motivo(conversa({ last_inbound_at: min(20), awaiting_since: min(400) }))).toBe("retoma");
  });
});

describe("ehSoDespedida — a última mensagem só encerra a conversa", () => {
  const texto = (body: string) => ({ type: "text", body });

  it.each([
    "obrigada",
    "Obrigado!",
    "OBRIGADAAA 🙏",
    "muito obrigada",
    "valeu",
    "beleza",
    "blz",
    "ok",
    "Okay.",
    "ta bom",
    "Tá bom 👍",
    "certo",
    "combinado",
    "até amanhã",
    "Até mais!",
    "de nada",
    "para você também",
    "pra vc tambem",
    "perfeito",
    "show",
    "top",
    "ok obrigada",
    "beleza, até amanhã!",
    "👍",
    "😘🙏",
  ])("%j é despedida", (body) => {
    expect(ehSoDespedida(texto(body))).toBe(true);
  });

  it("figurinha e reação são despedida", () => {
    expect(ehSoDespedida({ type: "sticker", body: null })).toBe(true);
    expect(ehSoDespedida({ type: "reaction", body: "❤️" })).toBe(true);
  });

  it.each([
    "ok, mas qual o horário?",
    "obrigada! quero marcar",
    "certo?",
    "ok obrigada, amanhã às 10 pode ser",
    "qual o valor",
    "bom dia",
    "sim",
    "obrigada obrigada obrigada obrigada obrigada obrigada obrigada",
  ])("%j NÃO é despedida", (body) => {
    expect(ehSoDespedida(texto(body))).toBe(false);
  });

  it("áudio, imagem e documento nunca são despedida: podem dizer qualquer coisa", () => {
    expect(ehSoDespedida({ type: "audio", body: null })).toBe(false);
    expect(ehSoDespedida({ type: "image", body: "obrigada" })).toBe(false);
    expect(ehSoDespedida({ type: "document", body: null })).toBe(false);
  });

  it("na regra: despedida segura a IA na pausa; áudio e pergunta retomam", () => {
    expect(motivo2(conversa(), { type: "text", body: "obrigada!" })).toBe("so_despedida");
    expect(motivo2(conversa(), { type: "sticker", body: null })).toBe("so_despedida");
    expect(motivo2(conversa(), { type: "audio", body: null })).toBe("retoma");
    expect(motivo2(conversa(), { type: "text", body: "ok, mas qual o horário?" })).toBe("retoma");
    expect(motivo2(conversa(), { type: "text", body: "obrigada! quero marcar" })).toBe("retoma");
  });
});

function motivo2(c: ConversaEmPausa, ultima: { type: string | null; body: string | null }) {
  const r = avaliarRetomadaPorClienteSemResposta(c, sel(), [ultima]);
  return r.retomar ? "retoma" : r.motivo;
}

describe("todasSaoDespedida — vale o conjunto pendente, não só a última", () => {
  const t = (body: string) => ({ type: "text", body });

  it("'qual o horário?' seguido de 'obrigada': ainda espera resposta, retoma", () => {
    // a mais nova primeiro, como o cron lê
    const pendentes = [t("obrigada"), t("qual o horário?")];
    expect(todasSaoDespedida(pendentes)).toBe(false);
    expect(avaliarRetomadaPorClienteSemResposta(conversa(), sel(), pendentes)).toEqual({ retomar: true, minutos: 15 });
  });

  it("'obrigada' + figurinha: tudo despedida, fica na pausa", () => {
    const pendentes = [{ type: "sticker", body: null }, t("obrigada")];
    expect(todasSaoDespedida(pendentes)).toBe(true);
    expect(motivoCom(pendentes)).toBe("so_despedida");
  });

  it("lista vazia não prova despedida: a regra fica do lado de responder", () => {
    expect(todasSaoDespedida([])).toBe(false);
    expect(motivoCom([])).toBe("retoma");
  });

  it("sem a lista (filtro barato do cron) a regra da despedida não se aplica", () => {
    expect(motivo(conversa())).toBe("retoma");
  });
});

function motivoCom(pendentes: Array<{ type: string | null; body: string | null }>) {
  const r = avaliarRetomadaPorClienteSemResposta(conversa(), sel(), pendentes);
  return r.retomar ? "retoma" : r.motivo;
}

describe("lerClienteSemRespostaMaxHoras", () => {
  const com = (v: unknown) => ({ atendimento: { pausa_cliente_sem_resposta_max_horas: v } });
  it.each([null, undefined, {}, com(0), com(25), com(2.5), com("6"), com(null)])("ausente ou inválido (%j) = 4", (s) => {
    expect(lerClienteSemRespostaMaxHoras(s)).toBe(4);
  });
  it("devolve o valor da organização nas duas pontas", () => {
    expect(lerClienteSemRespostaMaxHoras(com(1))).toBe(1);
    expect(lerClienteSemRespostaMaxHoras(com(24))).toBe(24);
  });
  it("gravar troca só ela", () => {
    expect(settingsComClienteSemRespostaMaxHoras({ x: 1, atendimento: { pausa_cliente_sem_resposta_min: 15 } }, 6)).toEqual({
      x: 1,
      atendimento: { pausa_cliente_sem_resposta_min: 15, pausa_cliente_sem_resposta_max_horas: 6 },
    });
  });
});
