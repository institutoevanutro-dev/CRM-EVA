/**
 * Lote 11 da auditoria de 17/11 — itens 125, 126 e 127.
 *
 * 125: tipo ligado a serviço dura o que o serviço dura (`resolverDuracaoDoTipo`);
 *      a tela tem de dizer isso, avisar serviço sem duração e deixar trocar
 *      serviço, sala, categoria e local no Editar.
 * 126: a lista de tipos vem antes dos blocos de configuração, que ficam fechados.
 * 127: o segundo tipo da mesma visita também nasce com responsável.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn((..._a: unknown[]) => Promise.resolve({ data: {} }));
const patch = vi.fn((..._a: unknown[]) => Promise.resolve({ data: {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: () => Promise.resolve({ data: [] }),
    post: (...a: unknown[]) => post(...a),
    patch: (...a: unknown[]) => patch(...a),
    delete: vi.fn(),
  },
}));

import { TiposDeAgendamentoClient, type TipoRow } from "./_client";

const EU = "22222222-2222-4222-8222-222222222222";
const SERVICO = "33333333-3333-4333-8333-333333333333";
const SEM_DURACAO = "44444444-4444-4444-8444-444444444444";
const PRODUTOS = [
  { id: SERVICO, nome: "Avaliação inicial", duracao: 50 },
  { id: SEM_DURACAO, nome: "Aplicação teste", duracao: null },
];

const TIPO: TipoRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Primeira consulta",
  slug: "primeira-consulta",
  description: null,
  category: "consulta",
  duration_minutes: 30,
  location_kind: "in_person",
  location_details: null,
  default_owner_user_id: EU,
  requires_confirmation: false,
  requires_patient: true,
  is_active: true,
  reminder_enabled: false,
  reminder_minutes_before: 60,
  reminder_extra_offsets_minutes: [],
  reminder_body: null,
  reminder_asks_confirmation: false,
  catalog_product_id: SERVICO,
  required_room_kind: null,
  concurrency_key: null,
};

function montar(tipos: TipoRow[] = [TIPO]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TiposDeAgendamentoClient
        tiposIniciais={tipos}
        pessoas={[{ id: EU, papel: "admin", nome: "Recepção" }]}
        produtos={PRODUTOS}
        podeEditar
        usuarioAtualId={EU}
        podeConfigurarGoogle={false}
        clientePelaAgendaLigado={false}
        podeLigarClientePelaAgenda={false}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  post.mockClear();
  patch.mockClear();
});

describe("item 125 — duração do serviço", () => {
  it("a lista mostra a duração do serviço, não a do tipo", () => {
    montar();
    const d = screen.getByTestId(`duracao-${TIPO.id}`);
    expect(d.textContent).toContain("50 min");
    expect(d.textContent).toContain("Avaliação inicial");
    expect(d.textContent).not.toContain("30 min");
  });

  it("serviço sem duração vira aviso", () => {
    montar([{ ...TIPO, catalog_product_id: SEM_DURACAO }]);
    expect(screen.getByTestId(`duracao-${TIPO.id}`).textContent).toContain("sem duração");
  });

  it("no Editar a duração some com serviço e o PATCH leva serviço, sala, categoria e local", async () => {
    const u = userEvent.setup();
    montar();
    await u.click(screen.getByTestId(`editar-${TIPO.id}`));
    expect(screen.queryByTestId(`editar-duracao-${TIPO.id}`)).toBeNull();
    expect(screen.getByTestId(`editar-duracao-do-servico-${TIPO.id}`).textContent).toContain("50 min");

    await u.selectOptions(screen.getByTestId(`editar-servico-${TIPO.id}`), "");
    expect(screen.getByTestId(`editar-duracao-${TIPO.id}`)).toBeTruthy();
    await u.selectOptions(screen.getByTestId(`editar-sala-${TIPO.id}`), "application");
    await u.selectOptions(screen.getByTestId(`editar-categoria-${TIPO.id}`), "retorno");
    await u.selectOptions(screen.getByTestId(`editar-local-${TIPO.id}`), "phone");
    await u.click(screen.getByTestId(`salvar-${TIPO.id}`));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0]?.[1]).toMatchObject({
      catalog_product_id: null,
      required_room_kind: "application",
      category: "retorno",
      location_kind: "phone",
      concurrency_key: null,
      duration_minutes: 30,
    });
  });
});

describe("item 126 — lista primeiro", () => {
  it("a lista vem antes das sanfonas, e elas nascem fechadas", () => {
    const { container } = montar();
    const lista = screen.getByTestId("lista-de-tipos");
    const sanfonas = container.querySelectorAll("details");
    expect(sanfonas.length).toBeGreaterThan(0);
    for (const s of sanfonas) {
      expect(s.open).toBe(false);
      expect(lista.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });
});

describe("item 127 — responsável no segundo tipo", () => {
  it("depois de criar um tipo, o rascunho seguinte volta com o responsável", async () => {
    const u = userEvent.setup();
    montar([]);
    await u.click(screen.getByTestId("abrir-novo-tipo"));
    await u.type(screen.getByTestId("novo-tipo-nome"), "Retorno");
    await u.click(screen.getByTestId("salvar-novo-tipo"));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));

    await u.click(await screen.findByTestId("abrir-novo-tipo"));
    expect((screen.getByTestId("novo-tipo-dono") as HTMLSelectElement).value).toBe(EU);
  });
});
