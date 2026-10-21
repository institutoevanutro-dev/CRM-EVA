// @vitest-environment node
/**
 * A JANELA DO LOTE É O MOMENTO DA ELEGIBILIDADE, NÃO O DA MARCAÇÃO.
 *
 * O lote só pegava `usable_for_rag_marked_at` dentro da janela. Marcar uma
 * conversa ABERTA como exemplo e resolvê-la mais de 24 h depois deixava o selo
 * nela e nenhum lote a pegava nunca.
 *
 * Roda a consulta real de `ingestConversationsBatch` sobre um banco falso com a
 * semântica dos filtros do PostgREST, e para na criação da versão (mockada para
 * falhar): o que interessa aqui é QUEM o lote selecionou.
 *
 * Portado do projeto original (DeskcommCRM, PR #3071 de @Tong-bit-art).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ selecionadas: [] as string[], conversas: [] as Array<Record<string, unknown>> }));

vi.mock("@/lib/ai/embed", () => ({ embedText: vi.fn() }));
vi.mock("@/lib/ai/embeddings/chave", () => ({
  resolverChaveDeEmbedding: async () => ({ apiKey: "k" }),
  modeloDeEmbedding: () => "text-embedding-3-small",
}));
vi.mock("@/lib/ai/rag/version", () => ({
  createKnowledgeVersion: async () => {
    throw new Error("parada do teste: a seleção já foi feita");
  },
  markVersionReady: vi.fn(),
  activateVersion: vi.fn(),
  markVersionFailed: vi.fn(),
}));

type Linha = Record<string, unknown>;
type Pred = (l: Linha) => boolean;

function cadeia(tabela: string) {
  const ops: Pred[] = [];
  const termo = (l: Linha, t: string) => {
    const m = /^([a-z_]+)\.gt\.(.+)$/.exec(t.trim());
    if (!m) throw new Error(`termo não suportado: ${t}`);
    return l[m[1]!] != null && String(l[m[1]!]) > m[2]!;
  };
  const resolver = () => {
    if (tabela === "ai_knowledge_sources") return { data: [{ id: "fonte-1" }], error: null };
    const linhas = deps.conversas.filter((l) => ops.every((p) => p(l)));
    deps.selecionadas.push(...linhas.map((l) => String(l.id)));
    return { data: linhas, error: null };
  };
  const c: Record<string, unknown> = {
    select: () => c,
    eq: (col: string, v: unknown) => (ops.push((l) => l[col] === v), c),
    gt: (col: string, v: string) => (ops.push((l) => l[col] != null && String(l[col]) > v), c),
    is: (col: string, v: unknown) => (ops.push((l) => l[col] === v), c),
    or: (expr: string) => (ops.push((l) => expr.split(",").some((t) => termo(l, t))), c),
    order: () => c,
    limit: () => Promise.resolve(resolver()),
  };
  return c;
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: cadeia }) }));

import { ingestConversationsBatch } from "@/lib/ai/rag/ingest/conversations";

const ORG = "11111111-1111-4111-8111-111111111111";
const horasAtras = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const conversa = (id: string, marcadaHa: number, resolvidaHa: number, extra: Linha = {}): Linha => ({
  id,
  organization_id: ORG,
  usable_for_rag: true,
  status: "resolved",
  rag_review_status: null,
  usable_for_rag_marked_at: horasAtras(marcadaHa),
  status_changed_at: horasAtras(resolvidaHa),
  ...extra,
});

describe("lote de conversas: a janela é a da elegibilidade", () => {
  beforeEach(() => {
    deps.selecionadas.length = 0;
    deps.conversas = [
      conversa("marcada-antes-resolvida-agora", 25, 1),
      conversa("marcada-agora-resolvida-antes", 1, 25),
      conversa("tudo-antigo", 25, 25),
      conversa("ja-ingerida", 1, 1, { rag_review_status: "ingested" }),
      conversa("aberta", 1, 1, { status: "open" }),
    ];
  });

  it("⭐ marcada há 25 h e resolvida agora entra; as duas ordens valem; fora da janela, ingerida e aberta ficam de fora", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await ingestConversationsBatch({ organizationId: ORG, agentId: "agente", sinceTs: new Date(Date.now() - 24 * 3_600_000) });
    expect(deps.selecionadas.sort()).toEqual(["marcada-agora-resolvida-antes", "marcada-antes-resolvida-agora"]);
  });
});
