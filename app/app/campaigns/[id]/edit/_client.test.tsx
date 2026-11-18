/**
 * Editar campanha — auditoria de 17/11/2026, lote 2.
 *
 *  - item 13 (P0): a edição mostra "com negócio no funil / na etapa" e reenvia
 *    o filtro INTEIRO. Antes, salvar apagava esse critério do público;
 *  - item 15: preparada, a tela oferece "Voltar para rascunho" (ela mandava
 *    voltar e o botão não existia);
 *  - item 21: a contagem some quando o filtro muda;
 *  - item 27: falha de carga tem "Tentar novamente", não cinza eterno.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FILTRO_VAZIO } from "@/lib/campanhas/audiencia";

import { filtroDoPublico, publicoDoFiltro } from "../../_components/PublicoDaCampanha";
import { EditarCampanha } from "./_client";

const FUNIL = "11111111-1111-4111-8111-111111111111";
const ETAPA = "22222222-2222-4222-8222-222222222222";
const GRAVADO = { ...FILTRO_VAZIO, com_alguma_tag: ["vip"], funis: [FUNIL], etapas: [ETAPA], limite: 100 };

const salvar = vi.fn();
const acao = vi.fn();
const refetch = vi.fn();
let consulta: { isLoading: boolean; isError: boolean; data: Record<string, unknown> | undefined; refetch: typeof refetch };
let previa: { data?: unknown; variables?: unknown; isPending: boolean; mutate: ReturnType<typeof vi.fn> };

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useActiveOrg: () => ({ orgId: "org" }) }));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({ useContactTagVocabulary: () => ({ data: ["vip"] }) }));
vi.mock("@/hooks/campanhas/useConfiguracao", () => ({ useTextosSalvos: () => ({ data: [] }) }));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [{ id: "canal" }] }),
  channelLabel: () => "Número da clínica",
}));
vi.mock("@/hooks/campanhas/useDestinoDaCampanha", () => ({
  useFunis: () => ({ data: [{ id: FUNIL, name: "Funil de retorno", is_default: false }] }),
  useEtapas: (id: string | null) => ({
    data: id ? [{ id: ETAPA, name: "Consulta feita", position: 1, is_won: false, is_lost: false }] : [],
  }),
  useAgentesPublicados: () => ({ data: [] }),
}));
vi.mock("@/hooks/campanhas/useCampanhas", () => ({
  useCampanha: () => consulta,
  useEditarCampanha: () => ({ mutate: salvar, isPending: false }),
  useAcaoDeCampanha: () => ({ mutate: acao, isPending: false }),
  usePreviaDaAudiencia: () => previa,
}));

function rascunho(extra: Record<string, unknown> = {}) {
  return {
    id: "c1",
    name: "Retorno de pacientes (fictícia)",
    status: "draft",
    channel_session_id: "canal",
    base_legal: "consent",
    lia_ref: null,
    message_body: "Oi, {{primeiro_nome}}!",
    audience_filter: GRAVADO,
    pipeline_id: null,
    stage_id: null,
    agent_id: null,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  consulta = { isLoading: false, isError: false, data: rascunho(), refetch };
  previa = { isPending: false, mutate: vi.fn() };
});

describe("o público na edição (item 13)", () => {
  it("mostra o funil e a etapa gravados", () => {
    render(<EditarCampanha id="c1" />);
    expect((screen.getByLabelText("Com negócio no funil") as HTMLSelectElement).value).toBe(FUNIL);
    expect((screen.getByLabelText("Com negócio na etapa") as HTMLSelectElement).value).toBe(ETAPA);
  });

  it("salvar reenvia o filtro inteiro — o funil e a etapa continuam no público", () => {
    render(<EditarCampanha id="c1" />);
    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));

    expect(salvar).toHaveBeenCalledTimes(1);
    expect(salvar.mock.calls[0]![0].audience_filter).toMatchObject({
      com_alguma_tag: ["vip"],
      funis: [FUNIL],
      etapas: [ETAPA],
      limite: 100,
    });
  });
});

describe("a contagem não sobrevive ao filtro (item 21)", () => {
  it("mudar um critério apaga o número da contagem anterior", () => {
    const filtro = filtroDoPublico(publicoDoFiltro(GRAVADO), GRAVADO);
    previa = {
      isPending: false,
      mutate: vi.fn(),
      data: { total: 9, elegiveis: 7, excluidos: 2, motivos: {}, amostra: [], legenda: {} },
      variables: { audience_filter: filtro, message_body: "Oi, {{primeiro_nome}}!" },
    };
    render(<EditarCampanha id="c1" />);
    expect(screen.getByRole("status").textContent).toContain("7");

    fireEvent.change(screen.getByLabelText("Máximo de contatos nesta campanha"), { target: { value: "50" } });
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("campanha preparada (item 15)", () => {
  it("oferece Voltar para rascunho", () => {
    consulta = { ...consulta, data: rascunho({ status: "ready" }) };
    render(<EditarCampanha id="c1" />);
    fireEvent.click(screen.getByRole("button", { name: "Voltar para rascunho" }));
    expect(acao).toHaveBeenCalledWith({ acao: "rascunho" });
  });
});

describe("falha de carga (item 27)", () => {
  it("diz que falhou e deixa tentar de novo", () => {
    consulta = { isLoading: false, isError: true, data: undefined, refetch };
    render(<EditarCampanha id="c1" />);
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
