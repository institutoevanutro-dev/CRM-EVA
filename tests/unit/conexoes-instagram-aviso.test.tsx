import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AVISO_DA_VOLTA, CanalInstagramClient } from "@/components/connections/CanalInstagramClient";
import { traduzir } from "@/lib/i18n/dicionario";

/**
 * A volta do login do Instagram (`?instagram=<código>`) vira uma frase na tela,
 * e a credencial ausente desliga o botão com o passo a passo.
 */
let busca = new URLSearchParams();
vi.mock("next/navigation", () => ({ useSearchParams: () => busca }));
const get = vi.fn();
vi.mock("@/lib/api/client", () => ({ apiClient: { get: (...a: unknown[]) => get(...a), patch: vi.fn(), delete: vi.fn() } }));

const CODIGOS = ["conectado", "cancelado", "link_vencido", "conta_em_outra_organizacao", "sem_credencial", "falhou"];

beforeEach(() => {
  get.mockResolvedValue({ data: { pode_conectar: true, contas: [], campos: [] } });
});

describe("aviso da volta do login do Instagram", () => {
  it("todo código do callback tem frase, com espanhol", () => {
    for (const c of CODIGOS) {
      const aviso = AVISO_DA_VOLTA[c];
      expect(aviso, c).toBeDefined();
      expect(traduzir(aviso!.texto, "es")).not.toBe(aviso!.texto);
    }
  });

  it.each(CODIGOS)("mostra a frase de ?instagram=%s", async (codigo) => {
    busca = new URLSearchParams({ instagram: codigo });
    render(<CanalInstagramClient />);
    expect(await screen.findByText(AVISO_DA_VOLTA[codigo]!.texto)).toBeTruthy();
  });

  it("sem código, nenhum aviso", () => {
    busca = new URLSearchParams();
    render(<CanalInstagramClient />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sem credencial: botão desligado e o caminho no painel da Meta", async () => {
    busca = new URLSearchParams();
    get.mockResolvedValue({ data: { pode_conectar: false, contas: [], campos: [] } });
    render(<CanalInstagramClient />);
    const botao = await screen.findByRole("button", { name: "Conectar Instagram" });
    expect(botao).toBeDisabled();
    expect(screen.getByText(/Configuração da API com login do Instagram/)).toBeTruthy();
  });
});
