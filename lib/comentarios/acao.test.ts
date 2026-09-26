import { beforeEach, expect, it, vi } from "vitest";
import type { RegraDeComentario } from "./regra";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const { aplicarRegra } = await import("./acao");
type Fake = Parameters<typeof aplicarRegra>[0] & { erroDaPrivada?: Error };

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
  return ultimaLinha as { situacao: string; motivo_do_toque: string | null };
}

beforeEach(() => {
  ultimaLinha = undefined;
  fake = {
    jaMandouPrivadoPara: null,
    erroDaPrivada: undefined,
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

it("passou de 7 dias: NÃO tenta o privado, publica a frase e diz por quê", async () => {
  const d = await aplicarRegra(fake, comentario, regra, seteDiasEUmMinuto);
  expect(d.ordem).toEqual(["publica"]);
  expect(linha().motivo_do_toque).toContain("7 dias");
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
