/**
 * NEM TODO NÚMERO É PROBLEMA.
 *
 * O total da primeira tela ganhou cor de atenção, e a tentação é pintar todo
 * total maior que zero. Isso quebra a tela para quem tem um dia BOM: "7" em
 * Minha agenda de hoje são sete consultas marcadas, e âmbar ali diz à recepção
 * que algo deu errado quando nada deu.
 *
 * A regra vigiada aqui é a distinção, não a cor: totais que contam coisas
 * ESPERANDO alguém (avisos, pacientes sem resposta, o que arrumar) recebem
 * `text-warning`; totais que contam o trabalho do dia, não.
 *
 * E a forma do Início claro (spec 2026-11-11): avisos por assunto, a espera
 * recente separada da antiga, e o quadro de tarefas some quando não há tarefa.
 */
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

import type { Avisos, Bloco, Esperando, Pendencias } from "@/lib/inicio/tipos";

const respostas = vi.hoisted(() => ({ inicio: null as unknown, health: null as unknown }));

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async (rota: string) => {
      if (rota.includes("health")) return { data: respostas.health };
      if (rota.includes("paineis")) throw new Error("fora do assunto deste teste");
      return { data: respostas.inicio };
    }),
  },
}));

function bloco(total: number): Bloco {
  return {
    ok: true,
    total,
    itens: Array.from({ length: Math.min(total, 2) }, (_, i) => ({ id: `i${i}`, titulo: `Item ${i}`, href: "/app/inbox" })),
  };
}
const ESPERANDO: Esperando = {
  ok: true,
  total: 6,
  comVoce: 2,
  semResponsavel: 4,
  veSemResponsavel: true,
  antigas: 21,
  itens: [{ id: "c1", titulo: "Marina Teles", desde: new Date(Date.now() - 2 * 3_600_000).toISOString(), href: "/app/inbox?id=c1" }],
};
const AVISOS: Avisos = {
  ok: true,
  total: 139,
  grupos: [
    { kind: "case_stale", rotulo: "Atendimentos parados, esperando decisão", total: 50 },
    { kind: "handoff", rotulo: "Paciente pediu para falar com uma pessoa", total: 27 },
  ],
  outros: 62,
};
const NADA_ESPERANDO: Esperando = { ok: true, total: 0, comVoce: 0, semResponsavel: 0, veSemResponsavel: true, antigas: 0, itens: [] };
const NENHUM_AVISO: Avisos = { ok: true, total: 0, grupos: [], outros: 0 };

async function montar() {
  const { PainelInicio } = await import("@/app/app/inicio/_components/PainelInicio");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <PainelInicio />
    </QueryClientProvider>,
  );
  await screen.findByText("Meu dia");
}

function cartao(titulo: string): HTMLElement {
  const c = screen.getByRole("heading", { name: titulo }).closest("section");
  if (!c) throw new Error(`cartão «${titulo}» não encontrado`);
  return c as HTMLElement;
}

/** O número do total, dentro do cartão do título. */
function totalDoCartao(titulo: string): HTMLElement {
  const p = cartao(titulo).querySelector(".numero-destaque");
  if (!p) throw new Error(`total do cartão «${titulo}» não encontrado`);
  return p as HTMLElement;
}

describe("painel Início — só pendência ganha cor", () => {
  beforeEach(() => {
    respostas.inicio = {
      meuDia: { avisos: AVISOS, esperando: ESPERANDO, agenda: bloco(7), tarefas: bloco(4) },
      gestao: null,
    };
    respostas.health = { status: "healthy" };
  });

  it("o total de avisos ganha cor de atenção", async () => {
    await montar();
    expect(totalDoCartao("Avisos, separados por assunto").className).toContain("text-warning");
  });

  it("o total de pacientes esperando resposta ganha cor de atenção", async () => {
    await montar();
    expect(totalDoCartao("Pacientes esperando resposta").className).toContain("text-warning");
  });

  /**
   * O CASO QUE JUSTIFICA O CAMPO. Mesmo total (7) dos avisos, e aqui ele é uma
   * boa notícia: a agenda do dia está cheia.
   */
  it("o total da agenda de hoje NÃO ganha cor de atenção — dia cheio não é problema", async () => {
    await montar();
    expect(totalDoCartao("Minha agenda de hoje").className).not.toContain("text-warning");
  });

  it("o total de tarefas NÃO ganha cor de atenção", async () => {
    await montar();
    expect(totalDoCartao("Minhas tarefas").className).not.toContain("text-warning");
  });

  it("zero continua verde e sem número — com a frase de cada bloco", async () => {
    respostas.inicio = {
      meuDia: { avisos: NENHUM_AVISO, esperando: NADA_ESPERANDO, agenda: bloco(0), tarefas: bloco(4) },
      gestao: null,
    };
    await montar();
    for (const frase of ["Ninguém esperando resposta.", "Nenhum compromisso seu hoje.", "Nenhum aviso para você."]) {
      expect(screen.getByText(frase).className).toContain("text-success");
    }
    expect(cartao("Pacientes esperando resposta").querySelector(".numero-destaque")).toBeNull();
  });
});

describe("painel Início — Meu dia claro", () => {
  beforeEach(() => {
    respostas.inicio = {
      meuDia: { avisos: AVISOS, esperando: ESPERANDO, agenda: bloco(7), tarefas: bloco(0) },
      gestao: null,
    };
    respostas.health = { status: "healthy" };
  });

  it("esperando resposta: o número é com você + sem responsável; as antigas ficam à parte, apagadas", async () => {
    await montar();
    const c = within(cartao("Pacientes esperando resposta"));
    expect(totalDoCartao("Pacientes esperando resposta")).toHaveTextContent("6");
    expect(c.getByText("esperando há até 3 dias")).toBeInTheDocument();
    expect(c.getByText("Com você").nextElementSibling).toHaveTextContent("2");
    expect(c.getByText("Sem responsável").nextElementSibling).toHaveTextContent("4");
    const antigas = c.getByText("Conversas antigas sem resposta (mais de 3 dias)");
    expect(antigas.nextElementSibling).toHaveTextContent("21");
    expect(antigas.parentElement?.className).toContain("text-text-muted");
    // A lista: quem espera, há quanto tempo, e a porta da conversa.
    const linha = c.getByRole("link", { name: /Marina Teles/ });
    expect(linha).toHaveAttribute("href", "/app/inbox?id=c1");
    expect(linha).toHaveTextContent("há 2 h");
  });

  it("quem não pode abrir conversa sem responsável não vê essa linha (o zero dela enganaria)", async () => {
    respostas.inicio = {
      meuDia: {
        avisos: AVISOS,
        esperando: { ...ESPERANDO, total: 2, semResponsavel: 0, veSemResponsavel: false },
        agenda: bloco(1),
        tarefas: bloco(0),
      },
      gestao: null,
    };
    await montar();
    const c = within(cartao("Pacientes esperando resposta"));
    expect(c.getByText("Com você")).toBeInTheDocument();
    expect(c.queryByText("Sem responsável")).toBeNull();
  });

  it("ninguém esperando há pouco, mas com conversa antiga: a frase verde e a linha das antigas", async () => {
    respostas.inicio = {
      meuDia: { avisos: AVISOS, esperando: { ...NADA_ESPERANDO, antigas: 9 }, agenda: bloco(1), tarefas: bloco(0) },
      gestao: null,
    };
    await montar();
    const c = within(cartao("Pacientes esperando resposta"));
    expect(c.getByText("Ninguém esperando resposta.")).toBeInTheDocument();
    expect(c.getByText("Conversas antigas sem resposta (mais de 3 dias)").nextElementSibling).toHaveTextContent("9");
    expect(c.queryByText("Com você")).toBeNull();
  });

  it("avisos por assunto: contagem + frase, do maior para o menor, com 'outros' no fim — cada linha abre a Central", async () => {
    await montar();
    const linhas = within(cartao("Avisos, separados por assunto")).getAllByRole("link").filter((a) => a.closest("li"));
    expect(linhas.map((a) => a.textContent?.replace(/Abrir →$/, ""))).toEqual([
      "50Atendimentos parados, esperando decisão",
      "27Paciente pediu para falar com uma pessoa",
      "62Outros avisos do sistema",
    ]);
    for (const a of linhas) expect(a).toHaveAttribute("href", "/app/ai/inbox");
  });

  it("sem tarefa, o quadro vira uma linha discreta — com a porta para as tarefas — e os avisos ocupam a largura toda", async () => {
    await montar();
    expect(screen.queryByRole("heading", { name: "Minhas tarefas" })).toBeNull();
    const linha = screen.getByText("Nenhuma tarefa sua para hoje.");
    expect(linha.className).toContain("text-text-muted");
    expect(within(linha).getByRole("link", { name: "Ver tarefas" })).toHaveAttribute("href", "/app/tasks");
    expect(cartao("Avisos, separados por assunto").className).toContain("md:col-span-2");
  });

  it("com tarefa, o quadro volta, ao lado dos avisos", async () => {
    respostas.inicio = { meuDia: { avisos: AVISOS, esperando: ESPERANDO, agenda: bloco(7), tarefas: bloco(4) }, gestao: null };
    await montar();
    expect(screen.getByRole("heading", { name: "Minhas tarefas" })).toBeInTheDocument();
    expect(screen.queryByText("Nenhuma tarefa sua para hoje.")).toBeNull();
    expect(cartao("Avisos, separados por assunto").className).not.toContain("md:col-span-2");
  });

  it("tarefas que falharam ao carregar continuam à vista: a falha não se esconde atrás da linha discreta", async () => {
    respostas.inicio = { meuDia: { avisos: AVISOS, esperando: ESPERANDO, agenda: bloco(7), tarefas: { ok: false } }, gestao: null };
    await montar();
    expect(within(cartao("Minhas tarefas")).getByRole("alert")).toHaveTextContent("Não consegui carregar este bloco.");
  });
});

describe("painel Início — Gestão em três quadros pequenos", () => {
  const PENDENCIAS: Pendencias = {
    ok: true,
    total: 9,
    grupos: [
      { tipo: "canal_fora", total: 2, itens: [{ id: "canal:1", titulo: "Recepção", href: "/app/connections" }, { id: "canal:2", titulo: "Comercial", href: "/app/connections" }] },
      {
        tipo: "agente_rascunho",
        total: 7,
        itens: Array.from({ length: 5 }, (_, i) => ({ id: `agente:${i}`, titulo: `Agente ${i}`, href: `/app/ai/agents/${i}` })),
      },
    ],
  };
  const gestao = (extra: Record<string, unknown> = {}) => ({
    configuracao: PENDENCIAS,
    numeros: { ok: true, numeros: { conversasComPaciente: 1, agendamentosCriados: 1, leadsGanhos: 0 } },
    gastoIa: { ok: true, consumidoCents: 1234, limiteCents: 5000 },
    ...extra,
  });
  beforeEach(() => {
    respostas.inicio = { meuDia: { avisos: NENHUM_AVISO, esperando: NADA_ESPERANDO, agenda: bloco(0), tarefas: bloco(0) }, gestao: gestao() };
    respostas.health = { status: "healthy", version: "5.6.0" };
  });

  it("Sistema: bolinha, 'Tudo no ar' e a versão", async () => {
    await montar();
    const c = within(cartao("Sistema"));
    expect(await c.findByText("Tudo no ar")).toBeInTheDocument();
    expect(c.getByText("versão 5.6.0")).toBeInTheDocument();
  });

  it("Sistema fora do ar avisa em frase, não só com a cor", async () => {
    respostas.health = { status: "degraded", version: "5.6.0" };
    await montar();
    expect(await within(cartao("Sistema")).findByRole("alert")).toHaveTextContent("Algum serviço está fora do ar. Avise o suporte.");
  });

  it("Gasto com IA: valor de limite, barra e porcentagem; sem limite, só o valor", async () => {
    await montar();
    const c = cartao("Gasto com IA no mês");
    expect(c).toHaveTextContent(/US\$\s?12,34 de US\$\s?50,00/);
    expect(within(c).getByText("25% do limite do mês")).toBeInTheDocument();
  });

  it("Gasto com IA sem limite: só o valor", async () => {
    respostas.inicio = { ...(respostas.inicio as object), gestao: gestao({ gastoIa: { ok: true, consumidoCents: 1234, limiteCents: null } }) };
    await montar();
    const c = cartao("Gasto com IA no mês");
    expect(c).toHaveTextContent(/US\$\s?12,34/);
    expect(within(c).getByText("sem limite configurado")).toBeInTheDocument();
    expect(within(c).queryByText(/% do limite/)).toBeNull();
  });

  it("Para arrumar: total com cor de atenção e o resumo por tipo; abaixo, a lista por tipo com a porta de cada item", async () => {
    await montar();
    expect(totalDoCartao("Para arrumar")).toHaveTextContent("9");
    expect(totalDoCartao("Para arrumar").className).toContain("text-warning");
    expect(within(cartao("Para arrumar")).getByText("WhatsApp fora: 2 · Agentes em rascunho: 7")).toBeInTheDocument();

    const lista = within(cartao("O que arrumar, por tipo"));
    expect(lista.getByRole("heading", { name: /WhatsApp fora do ar/ })).toHaveTextContent("2");
    expect(lista.getByRole("link", { name: /Recepção/ })).toHaveAttribute("href", "/app/connections");
    expect(lista.getByRole("link", { name: /Agente 0/ })).toHaveAttribute("href", "/app/ai/agents/0");
    // 7 agentes, 5 na lista: o resto tem porta para a tela que mostra todos.
    expect(lista.getByRole("link", { name: /e mais 2/ })).toHaveAttribute("href", "/app/ai/agents");
  });

  it("nada para arrumar: frase verde e nenhuma lista", async () => {
    respostas.inicio = { ...(respostas.inicio as object), gestao: gestao({ configuracao: { ok: true, total: 0, grupos: [] } }) };
    await montar();
    expect(within(cartao("Para arrumar")).getByText("Tudo configurado.").className).toContain("text-success");
    expect(screen.queryByRole("heading", { name: "O que arrumar, por tipo" })).toBeNull();
  });
});
