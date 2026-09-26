import { beforeEach, expect, it, vi } from "vitest";
import type { RegraDeComentario } from "./regra";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const { aplicarRegra } = await import("./acao");
type Fake = Parameters<typeof aplicarRegra>[0] & {
  erroDaPrivada?: Error;
  /** Lido por `jaMandouPrivado` — mesmo par (mídia, autor) do briefing original. */
  jaMandouPrivadoPara?: { mediaId: string; autorIgsid: string } | null;
};

const comentario = {
  id: "IC-1",
  organizationId: "org",
  commentId: "C-1",
  mediaId: "MEDIA-9",
  autorIgsid: "IGSID-7",
  comentadoEm: "2026-09-26T12:00:00Z",
};

const regra: RegraDeComentario = {
  id: "regra-1",
  mediaId: "MEDIA-9",
  palavra: "cardapio",
  textoDoDirect: "aqui está o link do cardápio 💚",
  frasePublica: "te mandei no privado 💚",
  criadaEm: "2026-09-01T00:00:00Z",
};

const seteDiasEUmMinuto = new Date("2026-10-03T12:01:00Z");

let fake: Fake;
let ultimaLinha: Record<string, unknown> | undefined;
function linha() {
  return ultimaLinha as { situacao: string; motivo_do_toque: string | null; private_reply_message_id: string | null };
}

beforeEach(() => {
  ultimaLinha = undefined;
  fake = {
    jaMandouPrivadoPara: null,
    erroDaPrivada: undefined,
    async reivindicar() {
      return true;
    },
    async jaMandouPrivado(input: { mediaId: string; autorIgsid: string }) {
      return (
        fake.jaMandouPrivadoPara?.mediaId === input.mediaId &&
        fake.jaMandouPrivadoPara?.autorIgsid === input.autorIgsid
      );
    },
    async enviarPrivada() {
      if (fake.erroDaPrivada) throw fake.erroDaPrivada;
      return { messageId: "MID-1" };
    },
    async enviarPublica() {
      return { replyId: "REPLY-1" };
    },
    async gravarDesfecho(_id: string, patch: Record<string, unknown>) {
      ultimaLinha = patch;
    },
  };
});

it("dentro dos 7 dias: manda o privado, depois a frase pública, e marca atendido", async () => {
  const d = await aplicarRegra(fake, comentario, regra, new Date("2026-09-27T12:00:00Z"));
  expect(d.ordem).toEqual(["privada", "publica"]);
  expect(linha().situacao).toBe("respondido_pela_regra");
});

it("passou de 7 dias: NÃO tenta o privado, publica a frase, diz por quê, e pede o toque de alguém (I2)", async () => {
  const d = await aplicarRegra(fake, comentario, regra, seteDiasEUmMinuto);
  expect(d.ordem).toEqual(["publica"]);
  expect(linha().motivo_do_toque).toContain("7 dias");
  expect(linha().situacao).toBe("esperando_voce");
});

it("mesma pessoa comentou de novo no mesmo vídeo: só a frase pública", async () => {
  fake.jaMandouPrivadoPara = { mediaId: "MEDIA-9", autorIgsid: "IGSID-7" };
  const d = await aplicarRegra(fake, comentario, regra, new Date("2026-09-27T12:00:00Z"));
  expect(d.ordem).toEqual(["publica"]);
});

it("privado recusado (perfil fechado): a pública ainda sai, e a linha pede seu toque", async () => {
  fake.erroDaPrivada = new Error("instagram_551: Essa pessoa não pode receber mensagens deste perfil.");
  const d = await aplicarRegra(fake, comentario, regra, new Date("2026-09-27T12:00:00Z"));
  expect(d.ordem).toEqual(["publica"]);
  expect(linha().situacao).toBe("esperando_voce");
});

// ─── C1: a pública sem proteção fazia o cron regastar a privada ────────────
it("C1 — pública falha: grava o desfecho mesmo assim (o id da privada não se perde), e uma segunda rodada não remanda a privada", async () => {
  let chamadasPrivada = 0;
  let privadaJaMandada = false;
  fake.enviarPrivada = async () => {
    chamadasPrivada++;
    privadaJaMandada = true;
    return { messageId: "MID-1" };
  };
  fake.enviarPublica = async () => {
    throw new Error("instagram_erro_de_envio: 429");
  };
  fake.jaMandouPrivado = async () => privadaJaMandada;

  const d1 = await aplicarRegra(fake, comentario, regra, new Date("2026-09-27T12:00:00Z"));
  expect(d1.ordem).toEqual(["privada"]);
  // O desfecho foi gravado apesar da pública ter lançado — não fica em "novo".
  expect(linha().private_reply_message_id).toBe("MID-1");
  expect(linha().situacao).toBe("esperando_voce");

  const d2 = await aplicarRegra(fake, comentario, regra, new Date("2026-09-27T12:05:00Z"));
  expect(d2.ordem).toEqual([]);
  expect(chamadasPrivada).toBe(1);
});

// ─── C3: nada reivindicava a linha antes de enviar ──────────────────────────
it("C3 — reivindicação que devolve false não manda nada e não grava", async () => {
  fake.reivindicar = async () => false;
  let chamouPrivada = false;
  let chamouPublica = false;
  let chamouGravar = false;
  fake.enviarPrivada = async () => {
    chamouPrivada = true;
    return { messageId: "MID-1" };
  };
  fake.enviarPublica = async () => {
    chamouPublica = true;
    return { replyId: "REPLY-1" };
  };
  fake.gravarDesfecho = async () => {
    chamouGravar = true;
  };

  const d = await aplicarRegra(fake, comentario, regra, new Date("2026-09-27T12:00:00Z"));
  expect(d.ordem).toEqual([]);
  expect(chamouPrivada).toBe(false);
  expect(chamouPublica).toBe(false);
  expect(chamouGravar).toBe(false);
});

// ─── M1: margem de segurança contra a janela formal ────────────────────────
it("M1 — falta 1h pro prazo formal de 7 dias: já conta como vencido, não some às pressas com um erro da Meta", async () => {
  // comentadoEm 2026-09-26T12:00 + 6d23h30 = 2026-10-03T11:30, dentro da
  // janela FORMAL de 7 dias mas dentro da margem de 1h de segurança.
  const d = await aplicarRegra(fake, comentario, regra, new Date("2026-10-03T11:30:00Z"));
  expect(d.ordem).toEqual(["publica"]);
  expect(linha().motivo_do_toque).toContain("7 dias");
});

// ─── M2: data inválida não vira "passaram mais de 7 dias" (mentira) ────────
it("M2 — data do comentário inválida: não finge que passou o prazo, tem motivo próprio", async () => {
  const comentarioComDataRuim = { ...comentario, comentadoEm: "isto-nao-e-data" };
  const d = await aplicarRegra(fake, comentarioComDataRuim, regra, new Date("2026-09-27T12:00:00Z"));
  expect(d.ordem).toEqual(["publica"]);
  expect(linha().situacao).toBe("esperando_voce");
  expect(linha().motivo_do_toque).toContain("inválida");
});
