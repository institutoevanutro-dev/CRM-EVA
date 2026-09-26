import { describe, expect, it, vi } from "vitest";

type Perfil = { nome: string | null; handle: string | null; foto: string | null };
const perfilDoRemetenteMock = vi.fn(async (): Promise<Perfil> => ({ nome: "Maria", handle: "maria", foto: null }));
vi.mock("@/lib/channels/instagram/graph", () => ({
  perfilDoRemetente: (...a: unknown[]) => perfilDoRemetenteMock(...(a as [])),
}));

const { deveBuscarPerfil, nomeAtualDoContato, preencherPerfilDoContato } = await import(
  "@/lib/channels/instagram/perfil-do-contato"
);

const agora = new Date("2026-09-25T12:00:00Z");
const H = 3_600_000;

describe("nomeAtualDoContato", () => {
  it("devolve o display_name quando há um", () => {
    expect(nomeAtualDoContato({ display_name: "Maria" })).toBe("Maria");
  });
  it("devolve null para registro nulo, indefinido ou sem nome", () => {
    expect(nomeAtualDoContato(null)).toBeNull();
    expect(nomeAtualDoContato(undefined)).toBeNull();
    expect(nomeAtualDoContato({ display_name: null })).toBeNull();
  });
});

describe("deveBuscarPerfil", () => {
  it("identidade nova sempre busca", () => {
    expect(deveBuscarPerfil({ identidadeNova: true, nomeAtual: "Ana", tentadoEm: null, agora })).toBe(true);
  });
  it("contato com nome não busca", () => {
    expect(deveBuscarPerfil({ identidadeNova: false, nomeAtual: "Ana", tentadoEm: null, agora })).toBe(false);
  });
  it("sem nome e nunca tentou, busca", () => {
    expect(deveBuscarPerfil({ identidadeNova: false, nomeAtual: null, tentadoEm: null, agora })).toBe(true);
  });
  it("sem nome, tentou há 2h, não busca", () => {
    expect(
      deveBuscarPerfil({ identidadeNova: false, nomeAtual: null, tentadoEm: new Date(agora.getTime() - 2 * H).toISOString(), agora }),
    ).toBe(false);
  });
  it("sem nome, tentou há 25h, busca", () => {
    expect(
      deveBuscarPerfil({ identidadeNova: false, nomeAtual: null, tentadoEm: new Date(agora.getTime() - 25 * H).toISOString(), agora }),
    ).toBe(true);
  });
});

function adminFalso(opts: { sourceMetadata?: Record<string, unknown> } = {}) {
  const chamadas: Record<"update", [string, unknown][]> = { update: [] };
  const admin = {
    from: vi.fn((tabela: string) => ({
      select: () => {
        const chain: { eq: () => typeof chain; maybeSingle: () => Promise<{ data: unknown; error: null }> } = {
          eq: () => chain,
          maybeSingle: async () =>
            tabela === "contacts"
              ? { data: { source_metadata: opts.sourceMetadata ?? {} }, error: null }
              : { data: null, error: null },
        };
        return chain;
      },
      update: (linha: unknown) => {
        chamadas.update.push([tabela, linha]);
        const q: Record<string, unknown> = {
          eq: () => q,
          is: () => q,
          select: () => q,
          then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [{ id: "C1" }], error: null }).then(res),
        };
        return q;
      },
    })),
  };
  return { admin, chamadas };
}

const input = { organizationId: "ORG", contactId: "C1", igsid: "IGSID1", token: "TOKEN", agora };

describe("preencherPerfilDoContato", () => {
  it("perfil com nome preenche display_name com o nome e grava perfil_tentado_em", async () => {
    perfilDoRemetenteMock.mockResolvedValueOnce({ nome: "Maria", handle: "maria", foto: null });
    const { admin, chamadas } = adminFalso();
    const r = await preencherPerfilDoContato(admin as never, input);
    expect(r).toBe("preenchido");
    const [, displayUpdate] = chamadas.update.find(([, l]) => (l as Record<string, unknown>).display_name) as [string, Record<string, unknown>];
    expect(displayUpdate.display_name).toBe("Maria");
    const [, metaUpdate] = chamadas.update.find(([, l]) => (l as Record<string, unknown>).source_metadata) as [string, Record<string, unknown>];
    expect((metaUpdate.source_metadata as Record<string, unknown>).perfil_tentado_em).toBe(agora.toISOString());
  });

  it("só handle preenche display_name = @handle", async () => {
    perfilDoRemetenteMock.mockResolvedValueOnce({ nome: null, handle: "maria", foto: null });
    const { admin, chamadas } = adminFalso();
    const r = await preencherPerfilDoContato(admin as never, input);
    expect(r).toBe("preenchido");
    const [, displayUpdate] = chamadas.update.find(([, l]) => (l as Record<string, unknown>).display_name) as [string, Record<string, unknown>];
    expect(displayUpdate.display_name).toBe("@maria");
  });

  it("perfil vazio grava só perfil_tentado_em e devolve sem_perfil", async () => {
    perfilDoRemetenteMock.mockResolvedValueOnce({ nome: null, handle: null, foto: null });
    const { admin, chamadas } = adminFalso();
    const r = await preencherPerfilDoContato(admin as never, input);
    expect(r).toBe("sem_perfil");
    expect(chamadas.update.some(([, l]) => (l as Record<string, unknown>).display_name)).toBe(false);
    const [, metaUpdate] = chamadas.update.find(([, l]) => (l as Record<string, unknown>).source_metadata) as [string, Record<string, unknown>];
    expect((metaUpdate.source_metadata as Record<string, unknown>).perfil_tentado_em).toBe(agora.toISOString());
  });

  it("o update de display_name é condicionado a display_name is null", async () => {
    perfilDoRemetenteMock.mockResolvedValueOnce({ nome: "Maria", handle: "maria", foto: null });
    const originalFrom = adminFalso().admin.from;
    void originalFrom;
    const isSpy = vi.fn();
    const admin = {
      from: vi.fn((tabela: string) => ({
        select: () => ({
          eq: function (this: unknown) { return this; },
          maybeSingle: async () => ({ data: { source_metadata: {} }, error: null }),
        }),
        update: (linha: unknown) => {
          const q: Record<string, unknown> = {
            eq: () => q,
            is: (...args: unknown[]) => { if (tabela === "contacts" && (linha as Record<string, unknown>).display_name) isSpy(...args); return q; },
            select: () => q,
            then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [{ id: "C1" }], error: null }).then(res),
          };
          return q;
        },
      })),
    };
    await preencherPerfilDoContato(admin as never, input);
    expect(isSpy).toHaveBeenCalledWith("display_name", null);
  });
});

/**
 * Concorrência em `contacts.source_metadata`: o PATCH de contatos
 * (`app/api/v1/contacts/_handler.ts`) e a reentrega do webhook escrevem a
 * MESMA coluna. O fake é STATEFUL e simula o outro escritor gravando ENTRE a
 * leitura e a escrita da primeira tentativa; o `update` só aplica quando o
 * filtro `eq("source_metadata", <lido>)` bate com o que está gravado (é o
 * compare-and-set que o PostgREST faz em jsonb, por valor).
 */
function adminComCorrida() {
  let gravado: Record<string, unknown> = {};
  let leituras = 0;
  const canonico = (o: Record<string, unknown>) =>
    JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1))));
  const admin = {
    from: (tabela: string) => ({
      select: () => {
        const chain: { eq: () => typeof chain; maybeSingle: () => Promise<{ data: unknown; error: null }> } = {
          eq: () => chain,
          maybeSingle: async () => {
            if (tabela !== "contacts") return { data: null, error: null };
            const lido = { ...gravado };
            leituras += 1;
            if (leituras === 1) gravado = { ...gravado, outra_chave: "do outro escritor" };
            return { data: { source_metadata: lido }, error: null };
          },
        };
        return chain;
      },
      update: (linha: Record<string, unknown>) => {
        const filtros: Record<string, unknown> = {};
        const executar = () => {
          if (tabela !== "contacts" || !linha.source_metadata) return { data: [{ id: "C1" }], error: null };
          if (typeof filtros.source_metadata === "string" && canonico(JSON.parse(filtros.source_metadata)) !== canonico(gravado)) {
            return { data: [], error: null };
          }
          gravado = linha.source_metadata as Record<string, unknown>;
          return { data: [{ id: "C1" }], error: null };
        };
        const q: Record<string, unknown> = {
          eq: (coluna: string, valor: unknown) => { filtros[coluna] = valor; return q; },
          is: () => q,
          select: () => q,
          then: (res: (v: unknown) => unknown) => Promise.resolve(executar()).then(res),
        };
        return q;
      },
    }),
  };
  return { admin, metadadosGravados: () => gravado };
}

describe("preencherPerfilDoContato sob concorrência", () => {
  it("não apaga o que outro escritor gravou entre a leitura e a escrita: as duas chaves sobrevivem", async () => {
    perfilDoRemetenteMock.mockResolvedValueOnce({ nome: "Maria", handle: "maria", foto: null });
    const { admin, metadadosGravados } = adminComCorrida();

    await preencherPerfilDoContato(admin as never, input);

    expect(metadadosGravados()).toMatchObject({
      outra_chave: "do outro escritor",
      perfil_tentado_em: agora.toISOString(),
      handle: "maria",
    });
  });
});
