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
 * Corrente genérica: qualquer `.eq/.is/.neq/.not/.ilike/.in/.select` devolve a
 * própria corrente (encadeável em qualquer ordem); `.maybeSingle()` e `await`
 * (via `then`) resolvem para o MESMO resultado fixo. Registra cada chamada de
 * `ilike` para inspeção.
 */
function corrente(resultado: { data: unknown; error: unknown }, registroIlike?: [string, string][]) {
  const c: Record<string, unknown> = {
    eq: () => c,
    is: () => c,
    neq: () => c,
    not: () => c,
    in: () => c,
    select: () => c,
    ilike: (coluna: string, valor: string) => {
      registroIlike?.push([coluna, valor]);
      return c;
    },
    maybeSingle: async () => resultado,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(resultado).then(resolve, reject),
  };
  return c;
}

/**
 * Fake de `SupabaseClient` para `juntarPorArroba`: a PRIMEIRA leitura de
 * `contact_channel_identities` (handle do próprio contato) usa `maybeSingle`;
 * a SEGUNDA (candidatos por `ilike`) e a leitura de `contacts` resolvem via
 * `then` (lista). Como as duas leituras de `contact_channel_identities` têm a
 * mesma forma de corrente, uma fila por tabela decide qual resultado sai em
 * cada chamada.
 */
function adminFalso(opts: {
  handleProprio?: string | null;
  outrasIdentidades?: { contact_id: string }[];
  contatosVivos?: { id: string; created_at: string }[];
  rpcErro?: { message: string } | null;
}) {
  const registroIlike: [string, string][] = [];
  const chamadasRpc: [string, unknown][] = [];
  const filaIdentidades = [
    { data: opts.handleProprio === undefined ? { handle: "maria.silva" } : opts.handleProprio ? { handle: opts.handleProprio } : null, error: null },
    { data: opts.outrasIdentidades ?? [], error: null },
  ];
  const admin = {
    rpc: vi.fn(async (nome: string, args: unknown) => {
      chamadasRpc.push([nome, args]);
      return { data: opts.rpcErro ? null : {}, error: opts.rpcErro ?? null };
    }),
    from: vi.fn((tabela: string) => {
      if (tabela === "contact_channel_identities") {
        const resultado = filaIdentidades.shift() ?? { data: null, error: null };
        return { select: () => corrente(resultado, registroIlike) };
      }
      if (tabela === "contacts") {
        return { select: () => corrente({ data: opts.contatosVivos ?? [], error: null }) };
      }
      throw new Error(`tabela inesperada: ${tabela}`);
    }),
  };
  return { admin, chamadasRpc, registroIlike };
}

describe("juntarPorArroba", () => {
  it("junta identidades de mesmo @ (case insensitive) e audita contact.merged com ator de sistema", async () => {
    const { admin, chamadasRpc } = adminFalso({
      handleProprio: "Maria.Silva",
      outrasIdentidades: [{ contact_id: "C2" }],
      contatosVivos: [
        { id: "C1", created_at: "2026-01-05T00:00:00Z" },
        { id: "C2", created_at: "2026-01-01T00:00:00Z" },
      ],
    });

    const resultado = await juntarPorArroba(admin as never, { organizationId: "ORG", contactId: "C1" });

    expect(resultado).toBe("juntou");
    expect(chamadasRpc).toContainEqual([
      "fn_mesclar_contatos",
      { p_organization_id: "ORG", p_contato_principal: "C2", p_contatos_secundarios: ["C1"] },
    ]);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "contact.merged",
        actorUserId: null,
        organizationId: "ORG",
        metadata: expect.objectContaining({ merged_contact_ids: ["C1"], motivo: "mesmo_arroba_instagram" }),
      }),
    );
  });

  it("escapa % _ e \\ do handle antes do ilike", async () => {
    const { admin, registroIlike } = adminFalso({ handleProprio: "ma%r_ia\\x", outrasIdentidades: [], contatosVivos: [] });
    await juntarPorArroba(admin as never, { organizationId: "ORG", contactId: "C1" });
    expect(registroIlike).toContainEqual(["handle", "ma\\%r\\_ia\\\\x"]);
  });

  it("contato sem handle: nada, sem rpc", async () => {
    const { admin, chamadasRpc } = adminFalso({ handleProprio: null });
    expect(await juntarPorArroba(admin as never, { organizationId: "ORG", contactId: "C1" })).toBe("nada");
    expect(chamadasRpc).toHaveLength(0);
  });

  it("outro contato do mesmo @ já absorvido (is_merged_into preenchido): ignorado, nada a fazer", async () => {
    const { admin, chamadasRpc } = adminFalso({
      handleProprio: "maria.silva",
      outrasIdentidades: [{ contact_id: "C2" }],
      // A busca por contatos VIVOS já filtra is_merged_into null — o
      // absorvido nem aparece nesta lista, então só resta C1.
      contatosVivos: [{ id: "C1", created_at: "2026-01-05T00:00:00Z" }],
    });
    expect(await juntarPorArroba(admin as never, { organizationId: "ORG", contactId: "C1" })).toBe("nada");
    expect(chamadasRpc).toHaveLength(0);
  });

  it("rpc devolve erro: nada, avisa no logger, nunca lança", async () => {
    const { admin } = adminFalso({
      handleProprio: "maria.silva",
      outrasIdentidades: [{ contact_id: "C2" }],
      contatosVivos: [
        { id: "C1", created_at: "2026-01-05T00:00:00Z" },
        { id: "C2", created_at: "2026-01-01T00:00:00Z" },
      ],
      rpcErro: { message: "contato_secundario_indisponivel" },
    });
    await expect(juntarPorArroba(admin as never, { organizationId: "ORG", contactId: "C1" })).resolves.toBe("nada");
    expect(loggerWarnMock).toHaveBeenCalled();
  });
});

describe("juntarDuplicadosPorArroba", () => {
  it("junta o contato mais novo de cada grupo de mesmo @ com 2+ contatos vivos, e conta os que juntaram", async () => {
    // Grupo "maria" = {C1 (mais novo), C2 (mais antigo)}; "outro" = {C3} sozinho, ignorado.
    const filaIdentidades = [
      { data: [{ contact_id: "C1", handle: "Maria" }, { contact_id: "C2", handle: "maria" }, { contact_id: "C3", handle: "outro" }], error: null },
      // Chamada interna de `juntarPorArroba(C1)`: handle próprio.
      { data: { handle: "Maria" }, error: null },
      // Chamada interna de `juntarPorArroba(C1)`: candidatos por ilike.
      { data: [{ contact_id: "C2" }], error: null },
    ];
    const chamadasRpc: [string, unknown][] = [];
    const admin = {
      rpc: vi.fn(async (nome: string, args: unknown) => {
        chamadasRpc.push([nome, args]);
        return { data: {}, error: null };
      }),
      from: vi.fn((tabela: string) => {
        if (tabela === "contact_channel_identities") {
          const resultado = filaIdentidades.shift() ?? { data: null, error: null };
          return { select: () => corrente(resultado) };
        }
        if (tabela === "contacts") {
          return {
            select: () =>
              corrente({
                data: [
                  { id: "C1", created_at: "2026-01-05T00:00:00Z" },
                  { id: "C2", created_at: "2026-01-01T00:00:00Z" },
                ],
                error: null,
              }),
          };
        }
        throw new Error(`tabela inesperada: ${tabela}`);
      }),
    };

    const total = await juntarDuplicadosPorArroba(admin as never, "ORG", 50);

    expect(total).toBe(1);
    expect(chamadasRpc).toContainEqual([
      "fn_mesclar_contatos",
      { p_organization_id: "ORG", p_contato_principal: "C2", p_contatos_secundarios: ["C1"] },
    ]);
  });

  it("nenhum grupo com 2+ contatos: zero, sem chamar o rpc", async () => {
    const admin = {
      rpc: vi.fn(),
      from: vi.fn((tabela: string) => {
        if (tabela === "contact_channel_identities") {
          return { select: () => corrente({ data: [{ contact_id: "C1", handle: "solo" }], error: null }) };
        }
        throw new Error(`tabela inesperada: ${tabela}`);
      }),
    };
    expect(await juntarDuplicadosPorArroba(admin as never, "ORG", 50)).toBe(0);
    expect(admin.rpc).not.toHaveBeenCalled();
  });
});
