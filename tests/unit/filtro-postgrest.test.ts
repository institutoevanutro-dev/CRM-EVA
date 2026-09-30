/**
 * B3 — texto do usuário e cursor decodificado viram pedaço da string do
 * `.or()` do PostgREST. Um `,` ou `)` ali acrescenta condição ao filtro.
 *
 * Os cursores são base64 sem HMAC: quem chama pode forjar qualquer conteúdo.
 * A defesa é a FORMA — instante ISO e uuid — conferida antes de interpolar.
 */
import { describe, expect, it } from "vitest";

import { escaparTermoDoOr, lerCursorJson, cursorValido, INSTANTE, ID } from "@/lib/api/filtro-postgrest";
import { decodeAuditCursor, encodeAuditCursor } from "@/lib/schemas/audit";
import { decodeLeadCaptureCursor, encodeLeadCaptureCursor } from "@/lib/schemas/lead-captures";
import { decodeCursor as decodeTimelineCursor, encodeCursor as encodeTimelineCursor } from "@/lib/leads/timeline-query";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const ID_OK = "9f0c2a4e-1111-4222-8333-444455556666";
const QUANDO = "2026-09-29T12:34:56.123456+00:00";

describe("escaparTermoDoOr", () => {
  it("não deixa delimitador do DSL passar", () => {
    const s = escaparTermoDoOr("x%,id.not.is.null),(a");
    expect(s).not.toMatch(/[,()]/);
    expect(s).toContain("\\%");
  });
  it("preserva o texto comum", () => {
    expect(escaparTermoDoOr("  Maria Silva ")).toBe("Maria Silva");
  });
});

describe("cursor", () => {
  const forma = { created_at: INSTANTE, id: ID };

  it("aceita o que o próprio servidor emite", () => {
    expect(lerCursorJson(b64(JSON.stringify({ created_at: QUANDO, id: ID_OK })), forma)).toEqual({
      created_at: QUANDO,
      id: ID_OK,
    });
  });

  it("recusa cursor com filtro injetado", () => {
    const ruim = { created_at: `${QUANDO},organization_id.neq.x`, id: ID_OK };
    expect(lerCursorJson(b64(JSON.stringify(ruim)), forma)).toBeNull();
    expect(cursorValido({ created_at: QUANDO, id: "x),or(id.gt.0" }, forma)).toBeNull();
  });

  it("recusa lixo sem lançar", () => {
    expect(lerCursorJson("%%%", forma)).toBeNull();
    expect(lerCursorJson(b64("[1,2]"), forma)).toBeNull();
  });

  it("os decoders de audit, lead-captures e timeline recusam cursor forjado", () => {
    expect(decodeAuditCursor(encodeAuditCursor({ created_at: QUANDO, id: ID_OK }))).toEqual({
      created_at: QUANDO,
      id: ID_OK,
    });
    expect(decodeAuditCursor(b64(`${QUANDO},id.gt.0|${ID_OK}`))).toBeNull();
    expect(decodeLeadCaptureCursor(encodeLeadCaptureCursor({ received_at: QUANDO, id: ID_OK }))).not.toBeNull();
    expect(decodeLeadCaptureCursor(b64(`${QUANDO}|${ID_OK}),or(id.gt.0`))).toBeNull();
    expect(decodeTimelineCursor(encodeTimelineCursor({ performed_at: QUANDO, id: ID_OK }))).not.toBeNull();
    expect(decodeTimelineCursor(b64(JSON.stringify({ performed_at: "x,y", id: ID_OK })))).toBeNull();
  });
});
