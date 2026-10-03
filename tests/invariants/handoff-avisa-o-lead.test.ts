import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  abrirPool,
  canalQueCaptura,
  carregarMotor,
  montaHandler,
  recriarConversa,
  rodaTurno,
  semearBase,
  type Motor,
} from "./turno-com-postgres";

/**
 * O TURNO INTEIRO, CONTRA POSTGRES DE VERDADE: quem pede um atendente RECEBE UMA
 * RESPOSTA — e ela sai ANTES de a trava ser armada.
 *
 * ## O defeito, medido em produção (2026-08-26, conversa `cdd9cbd8`)
 *
 * O cliente escreveu "preciso de falar com atendente". A detecção determinística
 * casou, `performHumanHandoff` rodou, e o turno deu `return` com o comentário
 * *"bot silencia: sem modelo, sem envio neste turno"*. Do lado de fora, no
 * WhatsApp: silêncio absoluto sobre um pedido explícito.
 *
 * ## Por que isto precisa de banco de verdade, e não do guarda estático
 *
 * `tests/unit/handoff-avisa-o-lead.test.ts` varre o AST e prova que nenhum sítio
 * de passagem existe sem um emissor de aviso ao lado. Ele NÃO prova que a
 * mensagem sai: um emissor cujo corpo fosse `return {avisado:false}` o
 * satisfaria. E, principalmente, ele não prova a ORDEM contra o estado real —
 * que é onde o conserto vive ou morre.
 *
 * A ordem não é preferência de redação. `performHumanHandoff` grava
 * `contacts.force_human = true`, e o gate 1 da cadeia (`stopGate`) relê
 * `(is_blocked or force_human)` DIRETO da fonte, sob o advisory lock, a cada
 * tentativa de envio. **Avisar depois da passagem é avisar ninguém.** O caso
 * "avisou ANTES de a trava existir" abaixo é o que impede alguém de "consertar"
 * invertendo a ordem e ficando verde.
 *
 * ## Harness
 *
 * `tests/invariants/turno-com-postgres.ts` (dividido com
 * `resposta-pronta-no-turno.test.ts`): handler real, canal que CAPTURA, modelo
 * fake, relógio dentro da janela anti-ban e `sleep` no-op.
 *
 * O modelo fake aqui é um CONTROLE, não um ator: se ele for chamado num turno de
 * pedido explícito, o desvio determinístico deixou de ser determinístico.
 */

const pool = abrirPool();
const ALVO = {
  org: "eeee0000-0000-4000-8000-000000000001",
  contact: "eeee0000-0000-4000-8000-000000000002",
  session: "eeee0000-0000-4000-8000-000000000003",
  conv: "eeee0000-0000-4000-8000-000000000004",
};
const { org: ORG, contact: CONTACT, conv: CONV } = ALVO;

interface EnvioCapturado {
  body: string;
  /** `contacts.force_human` NO INSTANTE do envio — a prova da ordem. */
  forceHumanNoEnvio: boolean;
}

let m: Motor;
let enviados: EnvioCapturado[] = [];
let modeloChamado = 0;

/** Grava um inbound e roda UM turno completo por cima dele. */
async function rodaTurnoCom(texto: string): Promise<void> {
  const handler = montaHandler(m, {
    aoChamarModelo: () => {
      modeloChamado += 1;
    },
    canal: () =>
      canalQueCaptura(async (i) => {
        // A leitura acontece DENTRO do envio, contra o banco: é o instante
        // exato em que a pergunta "a trava já está armada?" tem resposta.
        const { rows } = await pool.query<{ force_human: boolean }>(
          "select force_human from contacts where id = $1",
          [CONTACT],
        );
        enviados.push({ body: i.body, forceHumanNoEnvio: rows[0]?.force_human === true });
        return enviados.length;
      }),
  });
  await rodaTurno(pool, m, ALVO, handler, [texto], "aviso");
}

beforeAll(async () => {
  m = await carregarMotor();
  await semearBase(pool, ALVO, "handoff-avisa");
});

beforeEach(async () => {
  enviados = [];
  modeloChamado = 0;
  await recriarConversa(pool, ALVO, "Lead que pede humano", "+5511900000777");
});

describe("pedido explícito de atendente", () => {
  it("o lead RECEBE uma resposta — e ela não é vazia", async () => {
    await rodaTurnoCom("preciso de falar com atendente");
    expect(
      enviados.map((e) => e.body),
      "o defeito original: pedido explícito de humano e ZERO mensagens ao lead",
    ).toHaveLength(1);
    expect(enviados[0]!.body.length).toBeGreaterThan(20);
  });

  it("o aviso saiu ANTES de a trava ser armada", async () => {
    // A asserção que impede o conserto de ser invertido. Com `force_human` já
    // gravado, o `stopGate` vetaria este mesmo envio — e o veto é mudo.
    await rodaTurnoCom("preciso de falar com atendente");
    expect(enviados[0]!.forceHumanNoEnvio, "avisou depois de armar a trava que veta o aviso").toBe(
      false,
    );
    const { rows } = await pool.query<{ force_human: boolean }>(
      "select force_human from contacts where id = $1",
      [CONTACT],
    );
    expect(rows[0]!.force_human, "a passagem não aconteceu — o teste mediu outra coisa").toBe(true);
  });

  it("nenhum token gasto: o desvio segue determinístico", async () => {
    await rodaTurnoCom("preciso de falar com atendente");
    expect(modeloChamado, "o desvio passou a chamar o modelo — custo por pedido de humano").toBe(0);
  });

  it("a conversa é devolvida à fila humana e silenciada", async () => {
    await rodaTurnoCom("preciso de falar com atendente");
    const { rows } = await pool.query<{ status: string; silencio: string | null; motivo: string | null }>(
      `select status, bot_silenced_until::text as silencio, last_handoff_reason as motivo
         from conversations where id = $1`,
      [CONV],
    );
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.silencio).toBe("infinity");
    expect(rows[0]!.motivo).toBe("requested_human");
  });

  it("a Central registra que o cliente FOI avisado", async () => {
    // O que muda a primeira frase que o atendente digita ao abrir a conversa.
    await rodaTurnoCom("preciso de falar com atendente");
    const { rows } = await pool.query<{ body: string }>(
      "select body from agent_inbox_items where organization_id = $1 and kind = 'handoff'",
      [ORG],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toMatch(/JÁ FOI avisado/u);
  });

  /**
   * GUARDA DE VACUIDADE. Sem ela, "exatamente 1 envio" poderia ser verdade por o
   * harness nunca ter chegado ao desvio — e o arquivo inteiro estaria medindo o
   * nada com cinco asserções verdes.
   */
  it("controle: inbound NEUTRO não dispara passagem nenhuma", async () => {
    await rodaTurnoCom("bom dia, qual o horário de vocês?");
    const { rows } = await pool.query<{ force_human: boolean }>(
      "select force_human from contacts where id = $1",
      [CONTACT],
    );
    expect(rows[0]!.force_human, "mensagem comum virou passagem para humano").toBe(false);
    expect(modeloChamado, "turno normal não chamou o modelo — o harness não rodou").toBeGreaterThan(0);
  });

  /**
   * O SEGUNDO turno do mesmo lead: já em handoff, o turno é NO-OP e não pode
   * mandar um segundo aviso. Sem este caso, um lead que insistisse receberia o
   * mesmo texto a cada mensagem.
   */
  it("lead já em handoff não recebe aviso de novo", async () => {
    await rodaTurnoCom("preciso de falar com atendente");
    expect(enviados).toHaveLength(1);
    enviados = [];
    await rodaTurnoCom("e aí, alguém aí?");
    expect(enviados, "o aviso repetiu a cada mensagem do lead já escalado").toHaveLength(0);
  });
});

describe("suspeita de opt-out", () => {
  it("recebe confirmação da parada, e ela não oferece atendente", async () => {
    await rodaTurnoCom("não quero mais receber mensagens de vocês");
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.body).toMatch(/parar|encerro|não mando/iu);
    expect(enviados[0]!.body).not.toMatch(/atendente/iu);
    expect(enviados[0]!.forceHumanNoEnvio, "confirmou depois de armar a trava").toBe(false);
    const { rows } = await pool.query<{ motivo: string | null }>(
      "select last_handoff_reason as motivo from conversations where id = $1",
      [CONV],
    );
    expect(rows[0]!.motivo).toBe("suspected_optout");
  });
});
