import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O EVENTO DE UMA CONVERSA ENTRA NA LISTA SEM REFAZER A BUSCA (#2366).
 *
 * Portado do projeto original (DeskcommCRM, PR #3806 de @webtecnica), adaptado.
 *
 * ─── O defeito, medido ───────────────────────────────────────────────────────
 * Quando uma conversa muda sem mensagem nova (lida, encerrada, etiquetada), o
 * Realtime entrega um `UPDATE` de `public.conversations`. O inbox tratava TODO
 * evento igual: `invalidateQueries(["conversations"])` — busca completa da
 * lista, para um evento que mudou UMA linha, com a linha mostrando os valores
 * velhos até a resposta chegar.
 *
 * ─── O que cada caso prova ──────────────────────────────────────────────────
 *   1. CONTROLE: a primeira carga ainda mostra o skeleton;
 *   2. ⭐ `UPDATE` de conversa que ESTÁ na lista: nenhum GET novo, nenhum
 *      skeleton, a linha com os valores novos, na MESMA posição;
 *   3. CONTROLE: conversa NOVA ainda entra pela recarga;
 *   4. conversa que SAI do filtro sai de fato, sem GET;
 *   5. o que muda a ORDEM continua indo ao servidor;
 *   6. rajada de eventos da mesma conversa não multiplica busca;
 *   e as guardas do fork:
 *   (a) busca da lista EM VOO: o evento vai para a recarga — a resposta velha
 *       em voo apagaria a mescla;
 *   (b) contato trocado, silêncio trocado, a linha de contato com a equipe e a
 *       trava do contato ligada em outra tela vão ao servidor (desde a 0332 a
 *       trava chega como `conversations.contato_segura_robo`, mas o embed do
 *       contato é a rota que monta);
 *   (c) contato oculto do Inbox (0372) sai da aba, sem GET;
 *   (d) as OUTRAS abas em cache ficam marcadas como velhas, sem GET;
 *   (e) a mescla que lança não perde o evento: recarga, e o erro é reportado.
 *
 * ─── O tempo das esperas ────────────────────────────────────────────────────
 * O fork agrupa os eventos em 600 ms (`useInvalidacaoAgrupada(600)` no hook).
 * Esperar 300 ms, como o original, daria VERDE falso no código sem o conserto:
 * a recarga ainda não teria saído quando o teste conta os GETs.
 *
 * ─── O que este arquivo NÃO finge ───────────────────────────────────────────
 * A etiqueta do CONTATO não viaja num evento de `conversations`: é outra
 * tabela. A linha falsa deste teste desenha `conversations.tags`, que é o que o
 * evento traz.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [] }),
}));
vi.mock("@/hooks/ai/useAutomaticoAtivo", () => ({ useAutomaticoAtivo: () => ({ data: true }) }));
/** A linha é dublê de propósito: este arquivo mede o DADO que chega até ela. */
vi.mock("@/components/inbox/ConversationListItem", () => ({
  ConversationListItem: ({
    conversation,
  }: {
    conversation: {
      id: string;
      status?: string;
      last_message_preview?: string | null;
      tags?: string[];
    };
  }) => (
    <div data-testid="linha" data-conversa={conversation.id}>
      {conversation.id}|{conversation.status}|{conversation.last_message_preview}|
      {(conversation.tags ?? []).join("+")}
    </div>
  ),
}));
vi.mock("@/hooks/realtime/useRefetchDeSeguranca", () => ({
  useRefetchDeSeguranca: () => ({
    divergencias: 0,
    ultimaDivergencia: null,
    ultimaVerificacao: null,
  }),
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

/** O canal falso guarda o `onChange` real — é por ele que o evento entra. */
const canal = vi.hoisted(() => ({
  onChange: null as null | ((payload: unknown) => void),
}));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: (cfg: { onChange: (payload: unknown) => void }) => {
    canal.onChange = cfg.onChange;
    return { status: "subscribed", ultimaEntrega: { current: null } };
  },
}));

/**
 * CADA GET FICA EM BOLSA — o teste decide quando a resposta chega, e é assim que
 * ele afirma "nenhuma busca nova saiu" sem depender de tempo.
 */
const chamadas = vi.hoisted(
  () =>
    [] as {
      url: string;
      resolver: (resposta: unknown) => void;
      recusar: (erro: unknown) => void;
    }[],
);
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (url: string) =>
      new Promise((resolver, recusar) => {
        chamadas.push({ url, resolver, recusar });
      }),
  },
}));

/**
 * Só o TIPO vem estaticamente (é apagado na compilação): o hook em si é
 * importado depois dos dublês, para o módulo já enxergar os mocks.
 */
import type { ConversationsFilters } from "@/hooks/inbox/useConversationsRealtime";

const { ConversationList } = await import("@/components/inbox/ConversationList");
const { useConversationsRealtime } = await import("@/hooks/inbox/useConversationsRealtime");

/** Uma linha de resposta, com os campos que a régua do evento lê. */
function conversa(id: string, extras: Record<string, unknown> = {}) {
  return {
    id,
    status: "open",
    last_message_preview: `última de ${id}`,
    tags: [] as string[],
    contato_oculto: false,
    contact_id: `contato-${id}`,
    channel_session_id: "sessao-1",
    assigned_to_user_id: null,
    bot_silenced_until: null,
    contacts: {
      id: `contato-${id}`,
      display_name: id,
      name: id,
      phone_number: "+5527999990000",
      tags: [],
      force_human: false,
      is_blocked: false,
    },
    ...extras,
  };
}

function pagina(linhas: ReturnType<typeof conversa>[]) {
  return { data: linhas, meta: { has_more: false, cursor: null } };
}

/** O skeleton de carregamento (`components/ui/skeleton.tsx`). */
const esqueleto = () => document.querySelectorAll(".animate-pulse").length;

/** Uma entrega do Realtime, no formato que o supabase-js entrega. */
function evento(eventType: "INSERT" | "UPDATE" | "DELETE", linha: Record<string, unknown>) {
  return {
    type: "postgres_changes",
    eventType,
    schema: "public",
    table: "conversations",
    new: linha,
    old: {},
  };
}

function Tela({ filtros }: { filtros: ConversationsFilters }) {
  const q = useConversationsRealtime(filtros, "org-1");
  return (
    <>
      <ConversationList listQuery={q} filters={filtros} selectedId={null} onSelect={() => undefined} />
      <div data-testid="estado" data-carregando={q.isLoading} data-buscando={q.isFetching} />
    </>
  );
}

function montar(filtros: ConversationsFilters) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Tela filtros={filtros} />
    </QueryClientProvider>,
  );
  return qc;
}

function busca(indice: number) {
  const chamada = chamadas[indice];
  if (!chamada) throw new Error(`nenhum GET na posição ${indice} — a fila tem ${chamadas.length}`);
  return chamada;
}

async function entregar(indice: number, linhas: ReturnType<typeof conversa>[]) {
  await act(async () => {
    busca(indice).resolver(pagina(linhas));
  });
}

/** O agrupamento do hook é de 600 ms: esperar menos deixaria a recarga para depois da contagem. */
async function esperarAgrupamento() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 700));
  });
}

/** Entrega um evento do Realtime e deixa a janela de agrupamento correr. */
async function entregarEvento(payload: Record<string, unknown>) {
  await act(async () => {
    canal.onChange!(payload);
  });
  await esperarAgrupamento();
}

const linhas = () =>
  Array.from(document.querySelectorAll('[data-testid="linha"]')).map((n) => n.textContent);

beforeEach(() => {
  chamadas.length = 0;
  canal.onChange = null;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("o evento de uma conversa entra na lista sem refazer a busca (#2366)", () => {
  it("CONTROLE: a primeira carga mostra o skeleton", async () => {
    montar({ status: "open" });
    await waitFor(() => expect(chamadas).toHaveLength(1));
    expect(esqueleto()).toBeGreaterThan(0);
  });

  it("⭐ UPDATE de conversa que está na lista: nenhum GET novo, nenhum skeleton, linha atualizada", async () => {
    montar({ status: "open" });
    await entregar(0, [conversa("c1"), conversa("c2")]);
    await waitFor(() => expect(screen.getByText(/^c2\|/)).toBeInTheDocument());
    expect(chamadas).toHaveLength(1);
    expect(esqueleto()).toBe(0);

    await entregarEvento(
      evento("UPDATE", {
        id: "c1",
        status: "open",
        last_message_preview: "atendida pela automação",
        tags: ["vip"],
      }),
    );

    expect(chamadas.length, "um evento de UMA conversa não pode declarar a lista inteira velha").toBe(1);
    expect(esqueleto(), "a lista não pode voltar ao skeleton").toBe(0);
    expect(linhas()).toEqual(["c1|open|atendida pela automação|vip", "c2|open|última de c2|"]);
    expect(screen.getByTestId("estado").dataset.buscando).toBe("false");
  });

  it("CONTROLE: conversa NOVA (que não estava na lista) ainda entra — a recarga existe para ela", async () => {
    montar({ status: "open" });
    await entregar(0, [conversa("c1")]);
    await waitFor(() => expect(screen.getByText(/^c1\|/)).toBeInTheDocument());

    await entregarEvento(evento("INSERT", conversa("c3")));
    await waitFor(() => expect(chamadas).toHaveLength(2), { timeout: 3000 });

    await entregar(1, [conversa("c3"), conversa("c1")]);
    await waitFor(() => expect(screen.getByText(/^c3\|/)).toBeInTheDocument());
  });

  it("conversa que SAI do filtro sai de fato, sem esperar uma busca", async () => {
    montar({ status: "open" });
    await entregar(0, [conversa("c1"), conversa("c2")]);
    await waitFor(() => expect(screen.getByText(/^c1\|/)).toBeInTheDocument());

    // A conversa foi encerrada: ela não pertence mais à aba "Abertas".
    await entregarEvento(
      evento("UPDATE", {
        id: "c1",
        status: "resolved",
        last_message_preview: "encerrada pela automação",
        tags: [],
      }),
    );

    await waitFor(() => expect(linhas()).toEqual(["c2|open|última de c2|"]));
    expect(chamadas).toHaveLength(1);
    expect(esqueleto()).toBe(0);
  });

  it("o que muda a ORDEM da lista continua pedindo o servidor (a conversa que recebeu sobe)", async () => {
    montar({ status: "open" });
    await entregar(0, [conversa("c1"), conversa("c2")]);
    await waitFor(() => expect(screen.getByText(/^c2\|/)).toBeInTheDocument());

    // Mensagem nova numa conversa que já estava na lista: `last_message_at` muda,
    // e com ele a POSIÇÃO. Quem sabe reordenar (e desempatar por `id`) é a rota.
    await entregarEvento(
      evento("UPDATE", {
        id: "c2",
        status: "open",
        last_message_at: "2026-10-31T18:00:00.000Z",
        last_message_preview: "mensagem nova",
        tags: [],
      }),
    );
    await waitFor(() => expect(chamadas).toHaveLength(2), { timeout: 3000 });

    await entregar(1, [conversa("c2", { last_message_preview: "mensagem nova" }), conversa("c1")]);
    await waitFor(() => expect(linhas()[0]).toMatch(/^c2\|/));
  });

  it("rajada de eventos da mesma conversa não multiplica busca", async () => {
    montar({ status: "open" });
    await entregar(0, [conversa("c1")]);
    await waitFor(() => expect(screen.getByText(/^c1\|/)).toBeInTheDocument());

    for (const etiqueta of ["vip", "vip+abc", "vip+abc+xyz"]) {
      await act(async () => {
        canal.onChange!(
          evento("UPDATE", {
            id: "c1",
            status: "open",
            last_message_preview: `passo ${etiqueta}`,
            tags: etiqueta.split("+"),
          }),
        );
      });
    }
    await esperarAgrupamento();

    expect(chamadas).toHaveLength(1);
    expect(linhas()).toEqual([`c1|open|passo vip+abc+xyz|vip+abc+xyz`]);
  });
});

describe("as guardas do fork: o que a mescla não decide", () => {
  it("(a) busca da lista EM VOO: o evento vai para a recarga, e a resposta velha não vence", async () => {
    const qc = montar({});
    await entregar(0, [conversa("c1"), conversa("c2")]);
    await waitFor(() => expect(screen.getByText(/^c2\|/)).toBeInTheDocument());

    // Uma busca sai e fica em voo (o "Carregar mais", a rede de 45 s, o foco).
    await act(async () => {
      void qc.refetchQueries({ queryKey: ["conversations"] });
    });
    await waitFor(() => expect(chamadas).toHaveLength(2));

    await act(async () => {
      canal.onChange!(evento("UPDATE", { id: "c1", last_message_preview: "lida pela outra recepção", tags: ["vip"] }));
    });
    // Mesclar aqui seria em vão: a resposta em voo foi pedida ANTES do evento e
    // apagaria a linha mesclada quando chegasse.
    await waitFor(() => expect(chamadas).toHaveLength(3), { timeout: 3000 });

    await entregar(1, [conversa("c1"), conversa("c2")]);
    await entregar(2, [conversa("c1", { last_message_preview: "lida pela outra recepção", tags: ["vip"] }), conversa("c2")]);
    await waitFor(() =>
      expect(linhas()).toEqual(["c1|open|lida pela outra recepção|vip", "c2|open|última de c2|"]),
    );
  });

  const vaoAoServidor = [
    {
      caso: "contato trocado (Juntar fichas): o embed do contato é da rota",
      filtros: {} as ConversationsFilters,
      emCache: conversa("c1"),
      mudanca: { id: "c1", contact_id: "contato-outro", tags: ["vip"] },
      doServidor: [conversa("c1", { contact_id: "contato-outro", tags: ["vip"] })],
      depois: ["c1|open|última de c1|vip"],
    },
    {
      caso: "silêncio trocado (infinity → null): a devolução mexe no contato",
      filtros: {} as ConversationsFilters,
      emCache: conversa("c1", { bot_silenced_until: "infinity" }),
      mudanca: { id: "c1", bot_silenced_until: null, tags: ["vip"] },
      doServidor: [conversa("c1", { tags: ["vip"] })],
      depois: ["c1|open|última de c1|vip"],
    },
    {
      caso: "Devolver ao automático na Fila: o contato com a equipe só muda no servidor",
      filtros: { comando: ["aguardando"] } as ConversationsFilters,
      emCache: conversa("c1", {
        contacts: { ...conversa("c1").contacts, force_human: true },
      }),
      mudanca: { id: "c1", status: "ai_handling", assignee_kind: "ai", bot_silenced_until: null },
      // O servidor sabe que `contacts.force_human` foi limpo: a conversa é do
      // automático e saiu da Fila.
      doServidor: [],
      depois: [],
    },
    {
      caso: "contato travado em outra tela, no Automático: o evento só traz contato_segura_robo (0332)",
      filtros: { comando: ["automatico"] } as ConversationsFilters,
      emCache: conversa("c1"),
      // "Sempre atendimento humano" grava só em `contacts`; o gatilho da 0332
      // copia a trava para as conversas do contato, e é esse UPDATE que chega.
      // O embed em cache ainda diz `force_human: false`: mesclado, ficaria aqui.
      mudanca: { id: "c1", status: "open", contato_segura_robo: true },
      // O servidor já conta a conversa como aguardando: ela sai do Automático.
      doServidor: [],
      depois: [],
    },
  ];
  it.each(vaoAoServidor.map((c) => [c.caso, c] as const))("(b) %s", async (_caso, cenario) => {
    const { filtros, emCache, mudanca, doServidor, depois } = cenario;
    montar(filtros);
    await entregar(0, [emCache]);
    await waitFor(() => expect(screen.getByText(/^c1\|/)).toBeInTheDocument());
    const antes = linhas();

    await act(async () => {
      canal.onChange!(evento("UPDATE", mudanca));
    });
    await waitFor(() => expect(chamadas).toHaveLength(2), { timeout: 3000 });
    expect(linhas(), "a linha não pode mudar antes de o servidor responder").toEqual(antes);

    await entregar(1, doServidor);
    await waitFor(() => expect(linhas()).toEqual(depois));
  });

  it("(c) contato oculto do Inbox sai da aba na hora, sem GET", async () => {
    montar({});
    await entregar(0, [conversa("c1"), conversa("c2")]);
    await waitFor(() => expect(screen.getByText(/^c1\|/)).toBeInTheDocument());

    await entregarEvento(evento("UPDATE", { id: "c1", contato_oculto: true }));

    expect(linhas()).toEqual(["c2|open|última de c2|"]);
    expect(chamadas).toHaveLength(1);
  });

  it("(d) as outras abas em cache ficam marcadas como velhas, sem GET novo", async () => {
    const qc = montar({});
    const daFila = ["conversations", { comando: ["aguardando"] }] as const;
    // A Fila visitada antes: em cache, sem ninguém olhando para ela agora.
    qc.setQueryData(daFila, { pages: [pagina([conversa("c1")])], pageParams: [undefined] });
    await entregar(0, [conversa("c1")]);
    await waitFor(() => expect(screen.getByText(/^c1\|/)).toBeInTheDocument());

    await entregarEvento(evento("UPDATE", { id: "c1", tags: ["vip"] }));

    expect(linhas()).toEqual(["c1|open|última de c1|vip"]);
    expect(qc.getQueryState(daFila)?.isInvalidated, "a Fila em cache seguiria velha por 30 s").toBe(true);
    expect(chamadas).toHaveLength(1);
  });

  it("(e) a mescla que lança não perde o evento: ele cai na recarga e o erro é reportado", async () => {
    const reportado = vi.fn();
    vi.stubGlobal("reportError", reportado);
    montar({});
    await entregar(0, [conversa("c1")]);
    await waitFor(() => expect(screen.getByText(/^c1\|/)).toBeInTheDocument());

    // `useRealtimeChannel` chama o `onChange` sem proteção: sem o `try` do hook,
    // este erro sairia pelo canal e o evento sumiria.
    const ilegivel = {
      get eventType(): string {
        throw new Error("payload ilegível");
      },
    };
    await act(async () => {
      canal.onChange!(ilegivel);
    });

    await waitFor(() => expect(chamadas).toHaveLength(2), { timeout: 3000 });
    expect(reportado).toHaveBeenCalledWith(expect.objectContaining({ message: "payload ilegível" }));
  });
});
