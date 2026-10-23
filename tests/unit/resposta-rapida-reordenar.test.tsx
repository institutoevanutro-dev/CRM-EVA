/**
 * A RESPOSTA RÁPIDA REORDENÁVEL (porte do original #3261, migration 0394), do
 * fio à tela e de volta ao Inbox.
 *
 * A listagem devolvia as respostas por `updated_at desc`: editar o texto de uma
 * resposta a empurrava para o topo da tela e do Inbox, sem como voltar. Prova:
 *   1. depois de reordenar, a LISTAGEM devolve a sequência escolhida (a
 *      asserção é na ordem do `data`, não na resposta do PUT), e recarregar
 *      mantém;
 *   2. o Inbox (menu `/` e a barra recolhida "Respostas rápidas") mostra a
 *      ordem definida;
 *   3. reordenar não muda conteúdo nem `updated_at`;
 *   4. `depois_de` de OUTRA organização é recusado, e vizinha de si mesma também;
 *   5. a escrita que a RLS recusa não vira sucesso nem audit, e a renumeração
 *      recusa ANTES do primeiro UPDATE (com o controle do manager);
 *   6. a resposta NOVA nasce no topo, sem empate com outra nova;
 *   7. a tela manda o VIZINHO da esquerda, dentro do assunto (adaptação do fork,
 *      que agrupa por assunto): na primeira posição do assunto, o vizinho é o
 *      que vem antes da primeira dele, e soltar em outro assunto não faz nada.
 *
 * O banco é um dublê stateful das consultas das rotas, com a RLS de
 * `message_templates` (todo membro lê compartilhado + próprio; escreve o
 * próprio com `agent` e o compartilhado só com manager+).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  apoio: vi.fn(),
  audit: vi.fn(),
  papel: { organizacao: "", usuario: "", podeCompartilhado: false },
  linhas: [] as Linha[],
  capturado: { onDragEnd: null as ((r: unknown) => void) | null },
  put: vi.fn(),
  listaDaTela: [] as MessageTemplate[],
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.guard }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.apoio }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => banco() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/api/client", () => ({
  apiClient: { put: h.put, get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/hooks/inbox/useMessageTemplates", async () => {
  const real = await vi.importActual<Record<string, unknown>>("@/hooks/inbox/useMessageTemplates");
  return {
    ...real,
    useMessageTemplates: () => ({ data: h.listaDaTela, isLoading: false, isError: false, refetch: vi.fn() }),
  };
});
vi.mock("@hello-pangea/dnd", () => ({
  DragDropContext: ({ onDragEnd, children }: { onDragEnd: (r: unknown) => void; children: ReactNode }) => {
    h.capturado.onDragEnd = onDragEnd;
    return <div>{children}</div>;
  },
  Droppable: ({ children }: { children: (p: Record<string, unknown>) => ReactNode }) =>
    children({ innerRef: () => {}, droppableProps: {}, placeholder: null }),
  Draggable: ({
    children,
    isDragDisabled,
  }: {
    children: (p: Record<string, unknown>, s: Record<string, unknown>) => ReactNode;
    isDragDisabled?: boolean;
  }) =>
    children(
      { innerRef: () => {}, draggableProps: { "data-arrastavel": isDragDisabled ? "nao" : "sim" }, dragHandleProps: {} },
      { isDragging: false },
    ),
}));

import { GET, POST } from "@/app/api/v1/message-templates/route";
import { PATCH } from "@/app/api/v1/message-templates/[id]/route";
import { PUT } from "@/app/api/v1/message-templates/[id]/ordem/route";
import { TemplateMenu } from "@/components/inbox/composer/TemplateMenu";
import { BarraDeRecursos } from "@/components/inbox/composer/BarraDeRecursos";
import { TemplatesClient } from "@/app/app/templates/_components/TemplatesClient";
import type { MessageTemplate } from "@/hooks/inbox/useMessageTemplates";

const ORG = "b7c30000-0000-4000-8000-000000000001";
const OUTRA_ORG = "b7c30000-0000-4000-8000-0000000000ff";
const USER = "b7c30000-0000-4000-8000-000000000002";

interface Linha {
  id: string;
  organization_id: string;
  owner_user_id: string | null;
  title: string;
  body: string;
  shortcut: string | null;
  media_item_ids: string[];
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  ordem: number;
}

function linha(id: string, ordem: number, extra: Partial<Linha> = {}): Linha {
  return {
    id,
    organization_id: ORG,
    owner_user_id: USER,
    title: `Título ${id}`,
    body: `Corpo ${id}`,
    shortcut: `s${id}`,
    media_item_ids: [],
    created_by_user_id: USER,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    ordem,
    ...extra,
  };
}

/**
 * O dublê do PostgREST: cada `from()` abre uma consulta NOVA, como o
 * supabase-js, com os mesmos encadeamentos que as rotas usam.
 */
function banco() {
  const visivel = (l: Linha) =>
    l.organization_id === h.papel.organizacao &&
    (l.owner_user_id === null || l.owner_user_id === h.papel.usuario);
  const escrevivel = (l: Linha) =>
    l.organization_id === h.papel.organizacao &&
    (l.owner_user_id === h.papel.usuario || (l.owner_user_id === null && h.papel.podeCompartilhado));

  function consulta() {
    const filtros: Array<[string, unknown]> = [];
    const ordem: Array<[string, boolean]> = [];
    let patch: Record<string, unknown> | null = null;
    let novo: Record<string, unknown> | null = null;
    let colunasDeVolta = "id";
    let teto = Number.POSITIVE_INFINITY;

    const casam = (base: Linha[]) =>
      base.filter((l) => filtros.every(([coluna, valor]) => l[coluna as keyof Linha] === valor));

    const executar = (): Array<Record<string, unknown>> => {
      if (novo) {
        const criada = linha(`n${h.linhas.length + 1}`, 0, {
          updated_at: new Date().toISOString(),
          ...(novo as Partial<Linha>),
        });
        if (!escrevivel(criada)) return [];
        h.linhas.push(criada);
        return [somente(criada, colunasDeVolta)];
      }
      if (patch) {
        const alvos = casam(h.linhas).filter(escrevivel);
        for (const alvo of alvos) Object.assign(alvo, patch);
        return alvos.map((l) => somente(l, colunasDeVolta));
      }
      const lista = casam(h.linhas.filter(visivel));
      lista.sort((a, b) => {
        for (const [coluna, ascendente] of ordem) {
          const x = a[coluna as keyof Linha] as never;
          const y = b[coluna as keyof Linha] as never;
          if (x === y) continue;
          return ascendente ? (x < y ? -1 : 1) : x < y ? 1 : -1;
        }
        return 0;
      });
      return lista.slice(0, teto).map((l) => somente(l, colunasDeVolta));
    };

    const builder = {
      select: (colunas?: string) => {
        if (colunas) colunasDeVolta = colunas;
        return builder;
      },
      eq: (coluna: string, valor: unknown) => {
        filtros.push([coluna, valor]);
        return builder;
      },
      update: (valores: Record<string, unknown>) => {
        patch = valores;
        return builder;
      },
      insert: (valores: Record<string, unknown>) => {
        novo = valores;
        return builder;
      },
      order: (coluna: string, opcoes?: { ascending?: boolean }) => {
        ordem.push([coluna, opcoes?.ascending ?? true]);
        return builder;
      },
      limit: (n: number) => {
        teto = n;
        return builder;
      },
      maybeSingle: async () => ({ data: executar()[0] ?? null, error: null }),
      single: async () => {
        const primeira = executar()[0];
        return primeira
          ? { data: primeira, error: null }
          : { data: null, error: { code: "PGRST116", message: "no rows" } };
      },
      then: (aoResolver?: ((v: unknown) => unknown) | null) =>
        Promise.resolve({ data: executar(), error: null }).then(aoResolver ?? ((v) => v)),
    };
    return builder;
  }

  return { from: (_tabela: string) => consulta() };
}

function somente(l: Linha, colunas: string): Record<string, unknown> {
  if (colunas.trim() === "id") return { id: l.id };
  const saida: Record<string, unknown> = {};
  for (const coluna of colunas.split(",").map((c) => c.trim())) saida[coluna] = l[coluna as keyof Linha];
  return saida;
}

function requisicao(corpo: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/message-templates/x/ordem", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

const parametros = (id: string) => ({ params: Promise.resolve({ id }) });

async function listar(): Promise<MessageTemplate[]> {
  const resposta = await GET(new NextRequest("http://localhost/api/v1/message-templates"));
  return ((await resposta.json()) as { data: MessageTemplate[] }).data;
}

beforeEach(() => {
  vi.resetAllMocks();
  h.papel = { organizacao: ORG, usuario: USER, podeCompartilhado: true };
  h.capturado.onDragEnd = null;
  h.guard.mockResolvedValue({ ok: true, user: { id: USER, idioma: "pt" }, org: { orgId: ORG, role: "manager" } });
  h.apoio.mockResolvedValue(null);
});

describe("a listagem sai na ordem do operador, não na de edição", () => {
  it("(1) reordenar salva a sequência: a listagem devolve a ordem escolhida", async () => {
    // `c` foi EDITADA por último: a listagem de ANTES a trazia primeiro.
    h.linhas = [
      linha("a", 1000, { updated_at: "2026-10-01T10:00:00.000Z" }),
      linha("b", 2000, { updated_at: "2026-10-01T11:00:00.000Z" }),
      linha("c", 3000, { updated_at: "2026-10-01T12:00:00.000Z" }),
    ];
    expect((await listar()).map((t) => t.id)).toEqual(["a", "b", "c"]);

    const resposta = await PUT(requisicao({ depois_de: "c" }), parametros("a"));
    expect(resposta.status).toBe(200);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "template.reordered", organizationId: ORG, resourceId: "a" }),
    );

    expect((await listar()).map((t) => t.id)).toEqual(["b", "c", "a"]);
    // E recarregar (uma leitura nova) mantém: a ordem mora na LINHA.
    expect((await listar()).map((t) => t.id)).toEqual(["b", "c", "a"]);
  });

  it("(2) o Inbox mostra a ordem definida: o menu `/` e a barra recolhida", async () => {
    h.linhas = [linha("a", 1000), linha("b", 2000), linha("c", 3000)];
    await PUT(requisicao({ depois_de: null }), parametros("c"));
    const templates = await listar();

    const menu = render(
      <TemplateMenu open query="" templates={templates} onPick={() => {}} onClose={() => {}} />,
    );
    const titulos = screen
      .getAllByRole("button")
      .map((botao) => botao.querySelector("span")?.textContent ?? "")
      .filter((texto) => texto.startsWith("Título "));
    expect(titulos).toEqual(["Título c", "Título a", "Título b"]);
    menu.unmount();

    // A barra nasce FECHADA (porte de 22/10): aberta, os botões saem na mesma ordem.
    render(<BarraDeRecursos respostas={templates} onEscolher={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Respostas rápidas \(3\)/ }));
    expect(
      within(screen.getByTestId("barra-de-recursos"))
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Título c", "Título a", "Título b"]);
  });

  it("(3) reordenar não muda conteúdo: título, corpo, atalho, imagens e updated_at intactos", async () => {
    const comImagem = linha("a", 1000, { media_item_ids: ["b7c30000-0000-4000-8000-0000000000aa"] });
    h.linhas = [comImagem, linha("b", 2000)];
    const antes = structuredClone(comImagem);

    await PUT(requisicao({ depois_de: "b" }), parametros("a"));

    const depois = h.linhas.find((l) => l.id === "a")!;
    expect(depois).toMatchObject({
      title: antes.title,
      body: antes.body,
      shortcut: antes.shortcut,
      media_item_ids: antes.media_item_ids,
      updated_at: antes.updated_at,
    });
    expect(depois.ordem).toBe(3000);
  });

  it("(4) recusa vizinho de OUTRA organização e vizinha de si mesma", async () => {
    h.linhas = [linha("a", 1000), linha("b", 2000), linha("alheia", 1500, { organization_id: OUTRA_ORG })];

    const alheia = await PUT(requisicao({ depois_de: "alheia" }), parametros("a"));
    expect(alheia.status).toBe(422);
    expect((await alheia.json()).error.code).toBe("validation_failed");

    const propria = await PUT(requisicao({ depois_de: "a" }), parametros("a"));
    expect(propria.status).toBe(422);

    expect(h.linhas.find((l) => l.id === "a")!.ordem).toBe(1000);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("(4b) recusa reordenar resposta que este papel não vê, e corpo sem `depois_de`", async () => {
    h.papel = { organizacao: ORG, usuario: USER, podeCompartilhado: false };
    h.linhas = [linha("a", 1000), linha("de-outro", 2000, { owner_user_id: "outro-usuario" })];

    expect((await PUT(requisicao({ depois_de: null }), parametros("de-outro"))).status).toBe(404);
    expect((await PUT(requisicao({}), parametros("a"))).status).toBe(422);
  });
});

describe("a escrita que a RLS recusa não vira sucesso", () => {
  function comoAgente() {
    h.papel = { organizacao: ORG, usuario: USER, podeCompartilhado: false };
    h.guard.mockResolvedValue({ ok: true, user: { id: USER, idioma: "pt" }, org: { orgId: ORG, role: "agent" } });
  }
  /** As três em `0`: empate, o caminho da renumeração. */
  const empatadas = () => [
    linha("p1", 0, { updated_at: "2026-10-01T12:00:00.000Z" }),
    linha("s", 0, { owner_user_id: null, updated_at: "2026-10-01T11:00:00.000Z" }),
    linha("p2", 0, { updated_at: "2026-10-01T10:00:00.000Z" }),
  ];
  const ordens = () => Object.fromEntries(h.linhas.map((l) => [l.id, l.ordem]));

  it("(P1) agent movendo resposta COMPARTILHADA: 403, sem audit e com a ordem intacta", async () => {
    comoAgente();
    h.linhas = [linha("a", 1000), linha("s", 2000, { owner_user_id: null })];

    const resposta = await PUT(requisicao({ depois_de: null }), parametros("s"));

    expect(resposta.status).toBe(403);
    expect((await resposta.json()).error.code).toBe("forbidden");
    expect(h.audit).not.toHaveBeenCalled();
    expect(ordens()).toEqual({ a: 1000, s: 2000 });
  });

  it("(P2, controle) manager com empate renumera a lista INTEIRA na ordem pedida", async () => {
    h.linhas = empatadas();

    const resposta = await PUT(requisicao({ depois_de: "p1" }), parametros("p2"));

    expect(resposta.status).toBe(200);
    expect(ordens()).toEqual({ p1: 1000, p2: 2000, s: 3000 });
    expect((await listar()).map((t) => t.id)).toEqual(["p1", "p2", "s"]);
  });

  it("(P2) agent com compartilhada na lista empatada: 409 sem NENHUMA linha escrita", async () => {
    comoAgente();
    h.linhas = empatadas();

    const resposta = await PUT(requisicao({ depois_de: "p1" }), parametros("p2"));

    expect(resposta.status).toBe(409);
    expect(ordens()).toEqual({ p1: 0, s: 0, p2: 0 });
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("a resposta nova nasce no topo, sem empate", () => {
  afterEach(() => vi.useRealTimers());

  async function criar(titulo: string): Promise<string> {
    const resposta = await POST(
      new NextRequest("http://localhost/api/v1/message-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: titulo, body: `Corpo ${titulo}` }),
      }),
    );
    expect(resposta.status).toBe(201);
    return ((await resposta.json()) as { data: { id: string } }).data.id;
  }

  it("(P3) cria D e depois E, edita D: E continua acima de D", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    h.linhas = [linha("velha", 1000)];

    vi.setSystemTime(new Date("2026-10-22T10:00:00.000Z"));
    const d = await criar("D");
    expect((await listar()).map((t) => t.id)).toEqual([d, "velha"]);

    vi.setSystemTime(new Date("2026-10-22T11:00:00.000Z"));
    const e = await criar("E");
    expect((await listar()).map((t) => t.id)).toEqual([e, d, "velha"]);

    // O PATCH de conteúdo carimba `updated_at`, e não pode mover D.
    vi.setSystemTime(new Date("2026-10-22T12:00:00.000Z"));
    const editada = await PATCH(
      new NextRequest(`http://localhost/api/v1/message-templates/${d}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "Corpo novo" }),
      }),
      parametros(d),
    );
    expect(editada.status).toBe(200);
    expect((await listar()).map((t) => t.id)).toEqual([e, d, "velha"]);
  });
});

describe("o arrasto da tela, dentro do assunto", () => {
  const tpl = (id: string, title: string, owner: string | null = USER): MessageTemplate => ({
    id,
    title,
    body: `b${id}`,
    shortcut: null,
    owner_user_id: owner,
  });

  function montarTela(lista: MessageTemplate[], canShare = true) {
    h.listaDaTela = lista;
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <TemplatesClient canShare={canShare} currentUserId={USER} />
      </QueryClientProvider>,
    );
  }

  async function soltar(draggableId: string, de: [string, number], para: [string, number]) {
    await waitFor(() => expect(h.capturado.onDragEnd).not.toBeNull());
    await act(async () => {
      h.capturado.onDragEnd?.({
        draggableId,
        source: { droppableId: de[0], index: de[1] },
        destination: { droppableId: para[0], index: para[1] },
        reason: "DROP",
        type: "DEFAULT",
        mode: "FLUID",
      });
    });
  }

  beforeEach(() => {
    h.put.mockResolvedValue({ data: { id: "1" } });
  });

  it("(6) soltar na primeira posição da lista manda `depois_de: null`", async () => {
    montarTela([tpl("1", "Um"), tpl("2", "Dois"), tpl("3", "Três")]);
    await soltar("3", ["assunto-0", 2], ["assunto-0", 0]);
    await waitFor(() =>
      expect(h.put).toHaveBeenCalledWith("/api/v1/message-templates/3/ordem", { depois_de: null }),
    );
  });

  it("(7) soltar no meio manda o VIZINHO da esquerda, não o índice", async () => {
    montarTela([tpl("1", "Um"), tpl("2", "Dois"), tpl("3", "Três")]);
    await soltar("1", ["assunto-0", 0], ["assunto-0", 2]);
    await waitFor(() =>
      expect(h.put).toHaveBeenCalledWith("/api/v1/message-templates/1/ordem", { depois_de: "3" }),
    );
  });

  it("(7b) com assuntos intercalados, o topo do assunto é o vizinho de antes da primeira dele", async () => {
    // Na lista inteira: A1, B1, A2, B2. Na tela: A [A1, A2], B [B1, B2].
    const lista = [
      tpl("a1", "A · um"),
      tpl("b1", "B · um"),
      tpl("a2", "A · dois"),
      tpl("b2", "B · dois"),
    ];
    // O servidor ainda não respondeu: o que a tela mostra é a ordem otimista.
    h.put.mockReturnValue(new Promise(() => {}));
    montarTela(lista);
    // B2 para o topo de B: entra logo antes de B1, isto é, depois de A1.
    await soltar("b2", ["assunto-1", 1], ["assunto-1", 0]);
    await waitFor(() =>
      expect(h.put).toHaveBeenCalledWith("/api/v1/message-templates/b2/ordem", { depois_de: "a1" }),
    );
    // A tela já mostra B2 antes de B1, sem esperar o servidor.
    const b = screen.getByRole("heading", { name: /^B/ }).closest("section")!;
    expect(within(b).getAllByText(/^(um|dois)$/).map((n) => n.textContent)).toEqual(["dois", "um"]);
  });

  it("(7c) soltar em OUTRO assunto não faz nada: mudar de grupo seria mudar o título", async () => {
    montarTela([tpl("a1", "A · um"), tpl("b1", "B · um")]);
    await soltar("a1", ["assunto-0", 0], ["assunto-1", 0]);
    expect(h.put).not.toHaveBeenCalled();
  });

  it("(8) a alça só existe no que este papel pode mover, e some durante a busca", () => {
    montarTela([tpl("1", "Um"), tpl("9", "Da equipe", null)], false);
    expect(screen.getAllByLabelText("Arrastar para reordenar")).toHaveLength(1);

    fireEvent.change(screen.getByLabelText("Buscar respostas"), { target: { value: "Um" } });
    expect(screen.queryAllByLabelText("Arrastar para reordenar")).toHaveLength(0);
  });
});
