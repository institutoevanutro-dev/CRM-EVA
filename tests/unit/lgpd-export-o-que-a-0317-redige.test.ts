import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mock.admin }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));
import { collectExportData } from "@/lib/lgpd/export-collector";

/**
 * O RELATÓRIO DO TITULAR ENTREGA O QUE A MIGRATION 0317 PASSOU A APAGAR.
 *
 * `tests/unit/lgpd-exporta-o-que-redige.test.ts` prova que a TABELA é visitada.
 * Aqui se prova o recorte: o que entra é do titular (e só dele), e o que não
 * pode sair não sai.
 */

type Row = Record<string, unknown>;
const ORG = "org-a";
const OUTRA_ORG = "org-b";
const TITULAR = "contato-a";
const pedido = { organizationId: ORG, requestId: "pedido-0317", contactId: TITULAR, externalCustomerId: null };
let rows: Record<string, Row[]>;

/** PostgREST de mentira: aplica `eq`, `in`, `range` e devolve só as colunas pedidas. */
class Consulta {
  colunas = "";
  filtros: [string, unknown][] = [];
  dentro: [string, unknown[]][] = [];
  pagina: [number, number] = [0, 999];
  constructor(readonly tabela: string) {}
  select(colunas: string) {
    this.colunas = colunas;
    return this;
  }
  eq(coluna: string, valor: unknown) {
    this.filtros.push([coluna, valor]);
    return this;
  }
  in(coluna: string, valores: unknown[]) {
    this.dentro.push([coluna, valores]);
    return this;
  }
  not() {
    return this;
  }
  order() {
    return this;
  }
  or() {
    return this;
  }
  limit(n: number) {
    this.pagina = [0, n - 1];
    return this;
  }
  range(de: number, ate: number) {
    this.pagina = [de, ate];
    return this;
  }
  async maybeSingle() {
    const r = await this.executar();
    return { ...r, data: r.data[0] ?? null };
  }
  then(ok: (r: unknown) => unknown, falha?: (e: unknown) => unknown) {
    return this.executar().then(ok, falha);
  }
  async executar() {
    const data = (rows[this.tabela] ?? [])
      .filter((l) => this.filtros.every(([c, v]) => l[c] === v))
      .filter((l) => this.dentro.every(([c, vs]) => vs.includes(l[c])))
      .slice(this.pagina[0], this.pagina[1] + 1)
      .map((l) =>
        this.colunas === "*" || this.colunas === ""
          ? l
          : Object.fromEntries(this.colunas.split(",").map((c) => [c.trim(), l[c.trim()]])),
      );
    return { data, error: null, count: data.length };
  }
}

beforeEach(() => {
  rows = {
    organizations: [{ id: ORG, legal_name: "Clínica Exemplo LTDA", display_name: "Clínica Exemplo", dpo_email: null }],
    contacts: [{ id: TITULAR, organization_id: ORG, name: "Joana Teste", created_at: "2026-09-01T00:00:00Z" }],
  };
  mock.admin.mockReturnValue({ from: (tabela: string) => new Consulta(tabela) });
});

describe("LGPD export: comentários do Instagram do titular (0317)", () => {
  const comentario = (id: string, over: Row): Row => ({
    id,
    organization_id: ORG,
    contact_id: null,
    media_id: "post-1",
    texto: `texto de ${id}`,
    autor_igsid: "IGSID-DA-JOANA",
    autor_handle: "joana.teste",
    comentado_em: "2026-09-10T00:00:00Z",
    situacao: "esperando_voce",
    sugestao_de_resposta: null,
    motivo_do_toque: null,
    ...over,
  });

  it("entra o que é dela — pelo IGSID da identidade ou pelo vínculo —, uma vez só, e nada de mais ninguém", async () => {
    rows.contact_channel_identities = [
      { id: "ident-1", organization_id: ORG, contact_id: TITULAR, channel: "instagram", external_id: "IGSID-DA-JOANA", handle: "joana.teste" },
    ];
    rows.instagram_comments = [
      comentario("pelo-igsid", {}),
      // Achado pelos DOIS braços: tem de sair uma vez.
      comentario("pelos-dois", { contact_id: TITULAR }),
      comentario("so-pelo-vinculo", { contact_id: TITULAR, autor_igsid: "OUTRO-IGSID-DELA" }),
      comentario("de-outra-pessoa", { autor_igsid: "IGSID-DO-PEDRO", autor_handle: "pedro" }),
      comentario("de-outra-org", { organization_id: OUTRA_ORG }),
    ];

    const payload = await collectExportData(pedido);

    expect((payload.instagram_comments ?? []).map((c) => c.id).sort()).toEqual([
      "pelo-igsid",
      "pelos-dois",
      "so-pelo-vinculo",
    ]);
    expect(payload.instagram_comments?.[0]).toMatchObject({ media_id: "post-1", autor_handle: "joana.teste" });
    // O IGSID não se repete em cada comentário: já está em `channel_identities`.
    expect(JSON.stringify(payload.instagram_comments)).not.toContain("IGSID-DA-JOANA");
  });

  it("identidade já anonimizada não tem IGSID: a marca `anonimizado:` não vira filtro", async () => {
    rows.contact_channel_identities = [
      { id: "ident-1", organization_id: ORG, contact_id: TITULAR, channel: "instagram", external_id: "anonimizado:ident-1", handle: null },
    ];
    rows.instagram_comments = [comentario("anonimo-de-outro", { autor_igsid: "anonimizado" })];

    const payload = await collectExportData(pedido);

    expect(payload.instagram_comments).toEqual([]);
  });
});

describe("LGPD export: o caso que a IA abriu, a demanda e os avisos (0317)", () => {
  const CONVERSA = "conversa-da-joana";
  const CONVERSA_ALHEIA = "conversa-do-pedro";

  beforeEach(() => {
    rows.conversations = [
      { id: CONVERSA, organization_id: ORG, contact_id: TITULAR, status: "open", channel: "whatsapp" },
      { id: CONVERSA_ALHEIA, organization_id: ORG, contact_id: "contato-b", status: "open", channel: "whatsapp" },
    ];
    rows.agent_cases = [
      { id: "caso-dela", organization_id: ORG, conversation_id: CONVERSA, status: "awaiting_human", title: "Estorno da Joana", summary: "Joana pagou duas vezes", blocker: "Falta o comprovante", source: "agent", context_snapshot: { recorte: "NAO-EXPORTAR" } },
      { id: "caso-do-pedro", organization_id: ORG, conversation_id: CONVERSA_ALHEIA, status: "awaiting_human", title: "Troca do Pedro", summary: "Pedro quer trocar", blocker: "Falta o pedido", source: "agent" },
      { id: "caso-de-outra-org", organization_id: OUTRA_ORG, conversation_id: CONVERSA, status: "awaiting_human", title: "Outra org", summary: "x", blocker: "y", source: "agent" },
    ];
    rows.agent_case_events = [
      { id: "evento-dela", organization_id: ORG, case_id: "caso-dela", kind: "human_replied", actor_kind: "human", body: "Liguei para a Joana", metadata: {} },
      { id: "evento-do-pedro", organization_id: ORG, case_id: "caso-do-pedro", kind: "human_replied", actor_kind: "human", body: "Liguei para o Pedro", metadata: {} },
    ];
    rows.demandas = [
      { id: "demanda-dela", organization_id: ORG, contact_id: TITULAR, agent_case_id: "caso-dela", origem: "handoff", assunto: "Estorno", estado: "em_atendimento", dono_kind: "humano", proximo_passo: "Ligar para a Joana amanhã" },
      { id: "demanda-do-pedro", organization_id: ORG, contact_id: "contato-b", origem: "inbound", assunto: "Troca", estado: "aberta", dono_kind: "ia", proximo_passo: null },
    ];
    rows.agent_inbox_items = [
      { id: "aviso-pelo-contato", organization_id: ORG, kind: "voice_call_missed", title: "Chamada perdida de +5527999990000", body: "Ninguém atendeu", status: "open", ref_kind: "contact", ref_id: TITULAR },
      { id: "aviso-pela-conversa", organization_id: ORG, kind: "handoff", title: "Assumir a conversa", body: "Resumo: Joana quer estorno", status: "open", ref_kind: "conversation", ref_id: CONVERSA },
      { id: "aviso-pelo-caso", organization_id: ORG, kind: "case_stale", title: "Um atendimento espera decisão", body: "\"Estorno da Joana\" está aguardando", status: "open", ref_kind: "agent_case", ref_id: "caso-dela" },
      { id: "aviso-do-pedro", organization_id: ORG, kind: "case_stale", title: "Um atendimento espera decisão", body: "\"Troca do Pedro\"", status: "open", ref_kind: "agent_case", ref_id: "caso-do-pedro" },
      { id: "aviso-sem-referencia", organization_id: ORG, kind: "qr_rescan", title: "Reconecte o WhatsApp", body: null, status: "open", ref_kind: null, ref_id: null },
    ];
  });

  it("entram os casos das conversas DELA, os eventos desses casos e as demandas dela — de mais ninguém", async () => {
    const payload = await collectExportData(pedido);

    expect(payload.cases?.map((c) => c.id)).toEqual(["caso-dela"]);
    expect(payload.cases?.[0]).toMatchObject({ title: "Estorno da Joana", summary: "Joana pagou duas vezes", blocker: "Falta o comprovante" });
    expect(payload.case_events?.map((e) => e.id)).toEqual(["evento-dela"]);
    expect(payload.demandas?.map((d) => d.id)).toEqual(["demanda-dela"]);
    expect(payload.demandas?.[0]).toMatchObject({ assunto: "Estorno", proximo_passo: "Ligar para a Joana amanhã" });
    const tudo = JSON.stringify(payload);
    expect(tudo).not.toContain("Pedro");
    // O recorte da conversa que foi ao modelo não sai: as mensagens já saem no bloco delas.
    expect(tudo).not.toContain("NAO-EXPORTAR");
  });

  it("entram os avisos que apontam para ela, para a conversa dela ou para o caso dela", async () => {
    const payload = await collectExportData(pedido);

    expect((payload.avisos_da_central ?? []).map((a) => a.id).sort()).toEqual([
      "aviso-pela-conversa",
      "aviso-pelo-caso",
      "aviso-pelo-contato",
    ]);
    expect(payload.avisos_da_central?.find((a) => a.id === "aviso-pelo-contato")?.title).toBe(
      "Chamada perdida de +5527999990000",
    );
  });

  it("titular sem conversa não consulta caso nenhum — `in ()` vazio não vira varredura da tabela", async () => {
    rows.conversations = [];

    const payload = await collectExportData(pedido);

    expect(payload.cases).toEqual([]);
    expect(payload.case_events).toEqual([]);
  });
});

