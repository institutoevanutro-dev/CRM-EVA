import { beforeEach, expect, it, vi } from "vitest";

const auditMock = vi.fn(async () => undefined);
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => auditMock(...(a as [])) }));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { enviarPrivadaDeGatilho } = await import("./acao");

type Fake = Parameters<typeof enviarPrivadaDeGatilho>[0];

const comentario = {
  id: "IC-1",
  organizationId: "org",
  commentId: "C-1",
  mediaId: "MEDIA-9",
  autorIgsid: "IGSID-7",
  comentadoEm: "2026-09-26T12:00:00Z",
};

const logoDepois = new Date("2026-09-26T12:05:00Z");
const TEXTO = "Olá! O que você busca?";

let jaMandou: boolean;
let erroDaPrivada: Error | null;
let enviadas: Array<{ commentId: string; texto: string; organizationId: string }>;
let fake: Fake;

beforeEach(() => {
  auditMock.mockClear();
  jaMandou = false;
  erroDaPrivada = null;
  enviadas = [];
  fake = {
    async jaMandouPrivado() {
      return jaMandou;
    },
    async enviarPrivada(input) {
      if (erroDaPrivada) throw erroDaPrivada;
      enviadas.push(input);
      return { messageId: "MSG-1" };
    },
  };
});

it("dentro da janela e sem privada anterior: manda o texto recebido e devolve o id", async () => {
  const r = await enviarPrivadaDeGatilho(fake, comentario, TEXTO, "preço", logoDepois);

  expect(r).toEqual({ tipo: "enviou", messageId: "MSG-1" });
  expect(enviadas).toEqual([{ organizationId: "org", commentId: "C-1", texto: TEXTO }]);
});

it("o envio bem-sucedido deixa rastro na auditoria, com o gatilho que o causou", async () => {
  await enviarPrivadaDeGatilho(fake, comentario, TEXTO, "preço", logoDepois);

  expect(auditMock).toHaveBeenCalledTimes(1);
  const [chamada] = auditMock.mock.calls[0] as [Record<string, unknown>];
  expect(chamada.action).toBe("comment.private_reply_sent");
  expect(chamada.resourceId).toBe("IC-1");
  expect((chamada.metadata as { gatilho: string }).gatilho).toBe("preço");
});

it("uma privada por pessoa e por vídeo: quem já recebeu não recebe de novo", async () => {
  jaMandou = true;

  const r = await enviarPrivadaDeGatilho(fake, comentario, TEXTO, "preço", logoDepois);

  expect(r).toEqual({ tipo: "ja_recebeu" });
  expect(enviadas).toEqual([]);
  expect(auditMock).not.toHaveBeenCalled();
});

it("pergunta pelo par (mídia, autor) — não pelo comentário", async () => {
  const vistos: Array<{ organizationId: string; mediaId: string; autorIgsid: string }> = [];
  fake.jaMandouPrivado = async (input) => {
    vistos.push(input);
    return false;
  };

  await enviarPrivadaDeGatilho(fake, comentario, TEXTO, "preço", logoDepois);

  expect(vistos).toEqual([{ organizationId: "org", mediaId: "MEDIA-9", autorIgsid: "IGSID-7" }]);
});

it("passados os 7 dias da Meta, nem tenta: a Graph recusaria", async () => {
  const r = await enviarPrivadaDeGatilho(
    fake,
    comentario,
    TEXTO,
    "preço",
    new Date("2026-10-03T12:01:00Z"),
  );

  expect(r).toEqual({ tipo: "janela_vencida" });
  expect(enviadas).toEqual([]);
});

it("a margem de 1h vale aqui também: 6 dias e 23h30 ainda manda", async () => {
  const r = await enviarPrivadaDeGatilho(
    fake,
    comentario,
    TEXTO,
    "preço",
    new Date("2026-10-03T10:30:00Z"),
  );

  expect(r.tipo).toBe("enviou");
});

it("data ilegível não é janela vencida: tem motivo próprio e não manda", async () => {
  const r = await enviarPrivadaDeGatilho(
    fake,
    { ...comentario, comentadoEm: "não é data" },
    TEXTO,
    "preço",
    logoDepois,
  );

  expect(r).toEqual({ tipo: "data_invalida" });
  expect(enviadas).toEqual([]);
});

it("a Meta recusando devolve o erro, não uma exceção: quem chama ainda tem de gravar a linha", async () => {
  erroDaPrivada = new Error("(#10) Application does not have permission");

  const r = await enviarPrivadaDeGatilho(fake, comentario, TEXTO, "preço", logoDepois);

  expect(r).toEqual({ tipo: "falhou", erro: "(#10) Application does not have permission" });
  expect(auditMock).not.toHaveBeenCalled();
});

it("texto em branco não vira mensagem vazia para a pessoa", async () => {
  const r = await enviarPrivadaDeGatilho(fake, comentario, "   ", "preço", logoDepois);

  expect(r.tipo).toBe("falhou");
  expect(enviadas).toEqual([]);
});
