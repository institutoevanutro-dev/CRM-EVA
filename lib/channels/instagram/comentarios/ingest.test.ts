import { describe, expect, it } from "vitest";
import type { ComentarioDoInstagram } from "../webhook";

const { ingerirComentario } = await import("./ingest");

const sessao = { id: "S1", organizationId: "ORG" };

const comentario: ComentarioDoInstagram = {
  igAccountId: "IGACC",
  externalId: "COMENTARIO-1",
  mediaId: "MEDIA-9",
  texto: "quero saber mais",
  autorIgsid: "IGSID9",
  autorHandle: "cliente",
  comentadoEm: new Date("2026-09-26T12:00:00Z"),
  eco: false,
};

function adminFalso(opts: { erroDoInsert?: { code: string; message: string } | null } = {}) {
  let linha: Record<string, unknown> | undefined;
  const admin = {
    from: (tabela: string) => ({
      insert: (l: Record<string, unknown>) => {
        if (tabela !== "instagram_comments") throw new Error(`tabela inesperada: ${tabela}`);
        linha = l;
        return {
          select: () => ({
            maybeSingle: async () =>
              opts.erroDoInsert
                ? { data: null, error: opts.erroDoInsert }
                : { data: { id: "IC1" }, error: null },
          }),
        };
      },
    }),
  };
  return { admin, linhaGravada: () => linha };
}

describe("ingerirComentario", () => {
  it("grava o comentário como novo", async () => {
    const { admin, linhaGravada } = adminFalso();
    const r = await ingerirComentario(admin as never, comentario, sessao);
    expect(r).toMatchObject({ status: "gravado" });
    expect(linhaGravada()).toMatchObject({ situacao: "novo", external_id: "COMENTARIO-1", media_id: "MEDIA-9" });
  });

  it("eco do próprio perfil não é gravado", async () => {
    const { admin, linhaGravada } = adminFalso();
    const r = await ingerirComentario(admin as never, { ...comentario, eco: true }, sessao);
    expect(r).toMatchObject({ status: "ignorado", motivo: "eco" });
    expect(linhaGravada()).toBeUndefined();
  });

  it("reentrega da Meta não duplica: 23505 é desfecho normal", async () => {
    const { admin } = adminFalso({ erroDoInsert: { code: "23505", message: "duplicate key" } });
    const r = await ingerirComentario(admin as never, comentario, sessao);
    expect(r).toMatchObject({ status: "ignorado", motivo: "ja_recebido" });
  });
});
