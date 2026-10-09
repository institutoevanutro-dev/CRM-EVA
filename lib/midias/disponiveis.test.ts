import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { blocoDaBiblioteca, carregarMidiasProntas } from "./disponiveis";

const ORG = "11111111-1111-4111-8111-111111111111";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const variante = (item: string, mime = "image/jpeg") => [
  { key: "A", storage_path: `${ORG}/${item}/a.jpg`, mime, size_bytes: 10 },
];
const linha = (n: number, o: Record<string, unknown> = {}) => ({
  id: id(n), title: `Item ${String(n).padStart(3, "0")}`, when_to_use: "quando perguntar", tags: ["x", "y"],
  variants: variante(id(n)), contains_person: false,
  consent_signed_at: null, consent_expires_at: null, consent_revoked_at: null, ...o,
});
const pool = (rows: unknown[]) => ({ query: async () => ({ rows }) }) as never;
const HOJE = "2026-10-08";

describe("carregarMidiasProntas", () => {
  it("pronta entra; sem termo, vencido, revogado, sem arquivo e caminho alheio não", async () => {
    const rows = [
      linha(1),
      linha(2, { contains_person: true }),
      linha(3, { contains_person: true, consent_signed_at: "2026-01-01", consent_expires_at: "2026-10-07" }),
      linha(4, { contains_person: true, consent_signed_at: "2026-01-01", consent_revoked_at: "2026-02-01T00:00:00Z" }),
      linha(5, { variants: [] }),
      linha(6, { variants: variante("outro-item") }),
      linha(7, { variants: variante(id(7), "application/pdf") }),
      linha(8, { contains_person: true, consent_signed_at: "2026-01-01", consent_expires_at: HOJE }),
    ];
    const r = await carregarMidiasProntas(pool(rows), ORG, HOJE);
    expect(r.map((i) => i.id)).toEqual([id(1), id(8)]);
  });

  it("limita a 30", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => linha(i + 1));
    expect(await carregarMidiasProntas(pool(rows), ORG, HOJE)).toHaveLength(30);
  });
});

describe("blocoDaBiblioteca", () => {
  it("null para lista vazia", () => expect(blocoDaBiblioteca([])).toBeNull());
  it("formato exato da linha", () => {
    const b = blocoDaBiblioteca([{ id: "abc", title: "Antes e depois", when_to_use: "dúvida de resultado", tags: ["a", "b"] }]);
    expect(b?.startsWith("BIBLIOTECA DE MÍDIAS\n")).toBe(true);
    expect(b?.split("\n").at(-1)).toBe("- abc · Antes e depois · quando usar: dúvida de resultado · etiquetas: a, b");
    expect(b).not.toContain("—");
  });
});

describe("wiring no turno", () => {
  it("o bloco só entra no system quando não é nulo e a lista fica no turno", () => {
    const src = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
    expect(src).toContain("const midiasProntas: MidiaDisponivel[] = await carregarMidiasProntas(pool, tenantId)");
    expect(src).toMatch(/const blocoMidias = blocoDaBiblioteca\(midiasProntas\);\s*if \(blocoMidias\) blocosResidentes\.push\(blocoMidias\)/);
  });
});
