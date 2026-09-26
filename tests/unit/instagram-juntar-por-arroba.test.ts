import { describe, expect, it, vi } from "vitest";

/**
 * Quem escreve para os dois perfis (mesmo @, IGSIDs diferentes) hoje ganha DOIS
 * contatos. `juntarPorArroba` funde no automático quando o @ bate — case
 * insensitive — chamando a MESMA `fn_mesclar_contatos` da rota de merge manual,
 * com service role (a função aceita sem `auth.uid()`, e quem resolve a org é
 * quem chama, nunca o body).
 */
const auditMock = vi.fn(async () => undefined);
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => auditMock(...(a as [])) }));
const loggerWarnMock = vi.fn();
vi.mock("@/lib/logger", () => ({ logger: { warn: (...a: unknown[]) => loggerWarnMock(...a), info: vi.fn(), error: vi.fn() } }));

/** Handle VIVO por IGSID, como a Graph devolveria agora. Ausente = a Graph falhou (os três null). */
let handlesVivos: Record<string, string | null> = {};
const perfilMock = vi.fn(async (_token: string, igsid: string) => ({
  nome: null,
  handle: handlesVivos[igsid] ?? null,
  foto: null,
}));
vi.mock("@/lib/channels/instagram/graph", () => ({
  perfilDoRemetente: (...a: unknown[]) => perfilMock(...(a as [string, string])),
}));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: async () => "TOKEN" }));

const { escolherPrincipal, juntarPorArroba, juntarDuplicadosPorArroba } = await import(
  "@/lib/channels/instagram/juntar-por-arroba"
);

describe("escolherPrincipal", () => {
  it("um único contato: null (nada a fundir)", () => {
    expect(escolherPrincipal([{ id: "C1", created_at: "2026-01-01T00:00:00Z" }])).toBeNull();
  });

  it("dois contatos: o principal é o mais antigo", () => {
    expect(
      escolherPrincipal([
        { id: "C2", created_at: "2026-01-02T00:00:00Z" },
        { id: "C1", created_at: "2026-01-01T00:00:00Z" },
      ]),
    ).toEqual({ principal: "C1", secundarios: ["C2"] });
  });

  it("empate no created_at: desempata pelo menor id (determinístico)", () => {
    expect(
      escolherPrincipal([
        { id: "C9", created_at: "2026-01-01T00:00:00Z" },
        { id: "C2", created_at: "2026-01-01T00:00:00Z" },
      ]),
    ).toEqual({ principal: "C2", secundarios: ["C9"] });
  });
});

/**
 * Mundo falso do `SupabaseClient`: cada consulta registra seus filtros e é
 * respondida a partir de um estado (identidades, contatos vivos, conversas por
 * IGSID). O `update` de identidade MUDA o estado — dá para provar que o handle
 * gravado passou a ser o vivo.
 */
type Identidade = { contact_id: string; external_id: string; handle: string | null };
type Consulta = { tabela: string; op: "select" | "update"; filtros: Record<string, unknown>; payload?: Record<string, unknown> };

function mundo(opts: {
  identidades: Identidade[];
  contatosVivos: { id: string; created_at: string }[];
  /** IGSIDs cuja conversa aponta para uma sessão com token. Default: todos. */
  semSessao?: string[];
  erroLeituraHandle?: { message: string };
  rpcErro?: { message: string };
}) {
  const identidades = opts.identidades.map((i) => ({ ...i }));
  const consultas: Consulta[] = [];
  const chamadasRpc: [string, unknown][] = [];
  const semSessao = new Set(opts.semSessao ?? []);

  function responder(q: Consulta): { data: unknown; error: unknown } {
    const f = q.filtros;
    if (q.tabela === "contact_channel_identities") {
      if (q.op === "update") {
        for (const i of identidades) if (i.external_id === f.external_id) Object.assign(i, q.payload);
        return { data: null, error: null };
      }
      if (f.contact_id) {
        if (opts.erroLeituraHandle) return { data: null, error: opts.erroLeituraHandle };
        return { data: identidades.filter((i) => i.contact_id === f.contact_id), error: null };
      }
      if (typeof f["ilike:handle"] === "string") {
        const alvo = (f["ilike:handle"] as string).replace(/\\(.)/g, "$1").toLowerCase();
        return {
          data: identidades.filter((i) => i.handle?.toLowerCase() === alvo && i.contact_id !== f["neq:contact_id"]),
          error: null,
        };
      }
      return { data: identidades.filter((i) => i.handle), error: null };
    }
    if (q.tabela === "contacts") {
      const ids = (f["in:id"] as string[]) ?? [];
      return { data: opts.contatosVivos.filter((c) => ids.includes(c.id)), error: null };
    }
    if (q.tabela === "conversations") {
      const igsid = f.provider_conversation_id as string;
      return { data: semSessao.has(igsid) ? [] : [{ channel_session_id: `S-${igsid}` }], error: null };
    }
    if (q.tabela === "channel_sessions") {
      const ids = (f["in:id"] as string[]) ?? [];
      return { data: ids.map((id) => ({ id, ig_token_encrypted: "cifrado" })), error: null };
    }
    throw new Error(`tabela inesperada: ${q.tabela}`);
  }

  const admin = {
    rpc: vi.fn(async (nome: string, args: unknown) => {
      chamadasRpc.push([nome, args]);
      return { data: opts.rpcErro ? null : {}, error: opts.rpcErro ?? null };
    }),
    from: (tabela: string) => {
      const q: Consulta = { tabela, op: "select", filtros: {} };
      const executar = () => {
        consultas.push(q);
        return responder(q);
      };
      const c: Record<string, unknown> = {
        select: () => c,
        update: (payload: Record<string, unknown>) => {
          q.op = "update";
          q.payload = payload;
          return c;
        },
        eq: (k: string, v: unknown) => ((q.filtros[k] = v), c),
        neq: (k: string, v: unknown) => ((q.filtros[`neq:${k}`] = v), c),
        ilike: (k: string, v: unknown) => ((q.filtros[`ilike:${k}`] = v), c),
        in: (k: string, v: unknown) => ((q.filtros[`in:${k}`] = v), c),
        is: () => c,
        not: () => c,
        limit: () => c,
        maybeSingle: async () => executar(),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve().then(executar).then(res, rej),
      };
      return c;
    },
  };
  return { admin, identidades, consultas, chamadasRpc };
}

const ANTIGO = "2026-01-01T00:00:00Z";
const NOVO = "2026-01-05T00:00:00Z";

describe("juntarPorArroba", () => {
  it("os dois @ VIVOS batem (sem diferenciar maiúsculas): junta e audita contact.merged com ator de sistema", async () => {
    handlesVivos = { IG_A: "Maria.Silva", IG_B: "maria.silva" };
    const { admin, chamadasRpc } = mundo({
      identidades: [
        { contact_id: "C_A", external_id: "IG_A", handle: "maria.silva" },
        { contact_id: "C_B", external_id: "IG_B", handle: "Maria.Silva" },
      ],
      contatosVivos: [
        { id: "C_A", created_at: ANTIGO },
        { id: "C_B", created_at: NOVO },
      ],
    });

    const resultado = await juntarPorArroba(admin as never, { organizationId: "ORG", contactId: "C_B" });

    expect(resultado).toEqual({ juntou: true, principal: "C_A" });
    expect(chamadasRpc).toContainEqual([
      "fn_mesclar_contatos",
      { p_organization_id: "ORG", p_contato_principal: "C_A", p_contatos_secundarios: ["C_B"] },
    ]);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "contact.merged",
        actorUserId: null,
        organizationId: "ORG",
        metadata: expect.objectContaining({ merged_contact_ids: ["C_B"], motivo: "mesmo_arroba_instagram" }),
      }),
    );
  });

  it("@ reciclado: A tinha @foo gravado mas hoje é @bar; B é @foo. Não junta, e o handle gravado de A vira @bar", async () => {
    handlesVivos = { IG_A: "bar", IG_B: "foo" };
    const { admin, chamadasRpc, identidades } = mundo({
      identidades: [
        { contact_id: "C_A", external_id: "IG_A", handle: "foo" },
        { contact_id: "C_B", external_id: "IG_B", handle: "foo" },
      ],
      contatosVivos: [
        { id: "C_A", created_at: ANTIGO },
        { id: "C_B", created_at: NOVO },
      ],
    });

    expect(await juntarPorArroba(admin as never, { organizationId: "ORG", contactId: "C_B" })).toEqual({ juntou: false });
    expect(chamadasRpc).toHaveLength(0);
    expect(identidades.find((i) => i.external_id === "IG_A")?.handle).toBe("bar");
  });

  it("a Graph falha para o candidato: não junta (nunca funde no escuro)", async () => {
    handlesVivos = { IG_B: "foo" }; // IG_A ausente = perfil sem handle
    const { admin, chamadasRpc, identidades } = mundo({
      identidades: [
        { contact_id: "C_A", external_id: "IG_A", handle: "foo" },
        { contact_id: "C_B", external_id: "IG_B", handle: "foo" },
      ],
      contatosVivos: [
        { id: "C_A", created_at: ANTIGO },
        { id: "C_B", created_at: NOVO },
      ],
    });
    expect(await juntarPorArroba(admin as never, { organizationId: "ORG", contactId: "C_B" })).toEqual({ juntou: false });
    expect(chamadasRpc).toHaveLength(0);
    expect(identidades.find((i) => i.external_id === "IG_A")?.handle).toBe("foo");
  });

  it("o candidato não tem sessão com token: não junta", async () => {
    handlesVivos = { IG_A: "foo", IG_B: "foo" };
    const { admin, chamadasRpc } = mundo({
      identidades: [
        { contact_id: "C_A", external_id: "IG_A", handle: "foo" },
        { contact_id: "C_B", external_id: "IG_B", handle: "foo" },
      ],
      contatosVivos: [
        { id: "C_A", created_at: ANTIGO },
        { id: "C_B", created_at: NOVO },
      ],
      semSessao: ["IG_A"],
    });
    expect(await juntarPorArroba(admin as never, { organizationId: "ORG", contactId: "C_B" })).toEqual({ juntou: false });
    expect(chamadasRpc).toHaveLength(0);
  });

  it("a Graph falha para o próprio contato: não junta", async () => {
    handlesVivos = { IG_A: "foo" };
    const { admin, chamadasRpc } = mundo({
      identidades: [
        { contact_id: "C_A", external_id: "IG_A", handle: "foo" },
        { contact_id: "C_B", external_id: "IG_B", handle: "foo" },
      ],
      contatosVivos: [
        { id: "C_A", created_at: ANTIGO },
        { id: "C_B", created_at: NOVO },
      ],
    });
    expect(await juntarPorArroba(admin as never, { organizationId: "ORG", contactId: "C_B" })).toEqual({ juntou: false });
    expect(chamadasRpc).toHaveLength(0);
  });

  it("de três candidatos, só o que ainda é o mesmo @ entra no merge", async () => {
    handlesVivos = { IG_A: "foo", IG_B: "foo", IG_C: "outra" };
    const { admin, chamadasRpc } = mundo({
      identidades: [
        { contact_id: "C_A", external_id: "IG_A", handle: "foo" },
        { contact_id: "C_B", external_id: "IG_B", handle: "foo" },
        { contact_id: "C_C", external_id: "IG_C", handle: "foo" },
      ],
      contatosVivos: [
        { id: "C_A", created_at: ANTIGO },
        { id: "C_B", created_at: NOVO },
        { id: "C_C", created_at: "2026-01-02T00:00:00Z" },
      ],
    });
    expect(await juntarPorArroba(admin as never, { organizationId: "ORG", contactId: "C_B" })).toEqual({
      juntou: true,
      principal: "C_A",
    });
    expect(chamadasRpc).toContainEqual([
      "fn_mesclar_contatos",
      { p_organization_id: "ORG", p_contato_principal: "C_A", p_contatos_secundarios: ["C_B"] },
    ]);
  });

  it("escapa % _ e \\ do handle antes do ilike", async () => {
    handlesVivos = { IG_B: "ma%r_ia\\x" };
    const { admin, consultas } = mundo({
      identidades: [{ contact_id: "C_B", external_id: "IG_B", handle: "ma%r_ia\\x" }],
      contatosVivos: [],
    });
    await juntarPorArroba(admin as never, { organizationId: "ORG", contactId: "C_B" });
    expect(consultas.some((q) => q.filtros["ilike:handle"] === "ma\\%r\\_ia\\\\x")).toBe(true);
  });

  it("contato sem handle: nada, sem rpc e sem Graph", async () => {
    perfilMock.mockClear();
    const { admin, chamadasRpc } = mundo({
      identidades: [{ contact_id: "C_B", external_id: "IG_B", handle: null }],
      contatosVivos: [],
    });
    expect(await juntarPorArroba(admin as never, { organizationId: "ORG", contactId: "C_B" })).toEqual({ juntou: false });
    expect(chamadasRpc).toHaveLength(0);
    expect(perfilMock).not.toHaveBeenCalled();
  });

  it("outro contato do mesmo @ já absorvido: ignorado, nada a fazer", async () => {
    handlesVivos = { IG_A: "foo", IG_B: "foo" };
    const { admin, chamadasRpc } = mundo({
      identidades: [
        { contact_id: "C_A", external_id: "IG_A", handle: "foo" },
        { contact_id: "C_B", external_id: "IG_B", handle: "foo" },
      ],
      contatosVivos: [{ id: "C_B", created_at: NOVO }],
    });
    expect(await juntarPorArroba(admin as never, { organizationId: "ORG", contactId: "C_B" })).toEqual({ juntou: false });
    expect(chamadasRpc).toHaveLength(0);
  });

  it("rpc devolve erro: nada, avisa no logger, nunca lança", async () => {
    handlesVivos = { IG_A: "foo", IG_B: "foo" };
    const { admin } = mundo({
      identidades: [
        { contact_id: "C_A", external_id: "IG_A", handle: "foo" },
        { contact_id: "C_B", external_id: "IG_B", handle: "foo" },
      ],
      contatosVivos: [
        { id: "C_A", created_at: ANTIGO },
        { id: "C_B", created_at: NOVO },
      ],
      rpcErro: { message: "contato_secundario_indisponivel" },
    });
    await expect(juntarPorArroba(admin as never, { organizationId: "ORG", contactId: "C_B" })).resolves.toEqual({
      juntou: false,
    });
    expect(loggerWarnMock).toHaveBeenCalled();
  });

  it("contato já é principal de um merge anterior (2+ identidades): segue funcionando", async () => {
    handlesVivos = { IG_A1: "foo", IG_A2: "foo", IG_C: "foo" };
    const { admin, chamadasRpc } = mundo({
      identidades: [
        { contact_id: "C_A", external_id: "IG_A1", handle: "foo" },
        { contact_id: "C_A", external_id: "IG_A2", handle: "foo" },
        { contact_id: "C_C", external_id: "IG_C", handle: "foo" },
      ],
      contatosVivos: [
        { id: "C_A", created_at: ANTIGO },
        { id: "C_C", created_at: NOVO },
      ],
    });
    expect(await juntarPorArroba(admin as never, { organizationId: "ORG", contactId: "C_A" })).toEqual({
      juntou: true,
      principal: "C_A",
    });
    expect(chamadasRpc).toContainEqual([
      "fn_mesclar_contatos",
      { p_organization_id: "ORG", p_contato_principal: "C_A", p_contatos_secundarios: ["C_C"] },
    ]);
  });

  it("erro ao ler o handle do próprio contato: nada, avisa no logger, nunca lança", async () => {
    const { admin } = mundo({ identidades: [], contatosVivos: [], erroLeituraHandle: { message: "conexão caiu" } });
    expect(await juntarPorArroba(admin as never, { organizationId: "ORG", contactId: "C1" })).toEqual({ juntou: false });
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "[instagram.juntar-por-arroba] ler o handle do contato falhou",
      expect.objectContaining({ organization_id: "ORG", contact_id: "C1", detail: "conexão caiu" }),
    );
  });
});

describe("juntarDuplicadosPorArroba", () => {
  it("grupo de mesmo @ gravado cujos @ vivos batem: junta e conta", async () => {
    handlesVivos = { IG_A: "maria", IG_B: "Maria" };
    const { admin, chamadasRpc } = mundo({
      identidades: [
        { contact_id: "C_A", external_id: "IG_A", handle: "maria" },
        { contact_id: "C_B", external_id: "IG_B", handle: "Maria" },
        { contact_id: "C_C", external_id: "IG_C", handle: "outro" },
      ],
      contatosVivos: [
        { id: "C_A", created_at: ANTIGO },
        { id: "C_B", created_at: NOVO },
        { id: "C_C", created_at: NOVO },
      ],
    });
    expect(await juntarDuplicadosPorArroba(admin as never, "ORG", 50)).toBe(1);
    expect(chamadasRpc).toContainEqual([
      "fn_mesclar_contatos",
      { p_organization_id: "ORG", p_contato_principal: "C_A", p_contatos_secundarios: ["C_B"] },
    ]);
  });

  it("grupo de mesmo @ gravado, mas um @ foi reciclado: a passada diária também não junta", async () => {
    handlesVivos = { IG_A: "bar", IG_B: "foo" };
    const { admin, chamadasRpc, identidades } = mundo({
      identidades: [
        { contact_id: "C_A", external_id: "IG_A", handle: "foo" },
        { contact_id: "C_B", external_id: "IG_B", handle: "foo" },
      ],
      contatosVivos: [
        { id: "C_A", created_at: ANTIGO },
        { id: "C_B", created_at: NOVO },
      ],
    });
    expect(await juntarDuplicadosPorArroba(admin as never, "ORG", 50)).toBe(0);
    expect(chamadasRpc).toHaveLength(0);
    expect(identidades.find((i) => i.external_id === "IG_A")?.handle).toBe("bar");
  });

  it("nenhum grupo com 2+ contatos: zero, sem chamar o rpc", async () => {
    const { admin, chamadasRpc } = mundo({
      identidades: [{ contact_id: "C1", external_id: "IG_1", handle: "solo" }],
      contatosVivos: [{ id: "C1", created_at: ANTIGO }],
    });
    expect(await juntarDuplicadosPorArroba(admin as never, "ORG", 50)).toBe(0);
    expect(chamadasRpc).toHaveLength(0);
  });
});
