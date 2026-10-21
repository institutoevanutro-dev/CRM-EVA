import { describe, expect, it } from "vitest";

import {
  MOTIVO_DA_PAUSA_DE_LIGACAO,
  avaliarRetomadaPorClienteSemResposta,
  selecionarClientesSemResposta,
  type ConversaEmPausa,
  type SelecaoDaPausa,
} from "@/lib/escalacao/devolucao-automatica";
import {
  lerClienteSemRespostaMin,
  lerPausaPorRespostaHumanaMin,
  settingsComClienteSemResposta,
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
