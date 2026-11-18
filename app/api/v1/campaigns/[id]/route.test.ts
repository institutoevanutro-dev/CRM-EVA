/**
 * `GET`/`PATCH /api/v1/campaigns/:id` — auditoria de 17/11/2026, lote 2.
 *
 *  1. (item 13, P0) Um PATCH que não manda `funis`/`etapas` NÃO apaga o que está
 *     gravado: o filtro mescla por chave, como `contacts.consent`. Era o defeito:
 *     a tela de edição mandava o filtro sem essas chaves e o público da campanha
 *     crescia sem ninguém ver.
 *  2. (item 18) Meia janela é recusada com frase legível, contra o valor
 *     MESCLADO — antes ela chegava ao CHECK do banco e voltava "Erro interno".
 *  3. (item 23) O GET devolve a janela que vale agora, para a tela dizer
 *     "aguardando o horário" em vez de "Enviando 0%".
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { FILTRO_VAZIO } from "@/lib/campanhas/audiencia";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { supabaseEmMemoria, type Linha } from "@/tests/helpers/supabase-em-memoria";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/automation/janela-do-canal", () => ({
  knobsDoCanal: vi.fn(async () => ({ ...PACING_DEFAULTS, windowStartHour: 7, windowEndHour: 22 })),
}));

const { GET, PATCH } = await import("./route");

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const ID = "cccccccc-0000-4000-8000-000000000001";
const CANAL = "dddddddd-0000-4000-8000-000000000001";
const FUNIL = "11111111-1111-4111-8111-111111111111";
const ETAPA = "22222222-2222-4222-8222-222222222222";

let banco: ReturnType<typeof supabaseEmMemoria>;

function campanha(extra: Linha = {}): Linha {
  return {
    id: ID,
    organization_id: ORG,
    name: "Retorno de pacientes (fictícia)",
    status: "draft",
    channel_session_id: CANAL,
    message_body: "Oi, {{primeiro_nome}}!",
    base_legal: "consent",
    lia_ref: null,
    audience_filter: { ...FILTRO_VAZIO, com_alguma_tag: ["vip"], funis: [FUNIL], etapas: [ETAPA], limite: 100 },
    audience_version: 1,
    content_version: 1,
    intervalo_segundos: null,
    janela_inicio_hora: null,
    janela_fim_hora: null,
    teto_diario: null,
    teto_horario: null,
    ...extra,
  };
}

function patch(corpo: unknown) {
  return PATCH(
    new NextRequest(`http://localhost/api/v1/campaigns/${ID}`, {
      method: "PATCH",
      body: JSON.stringify(corpo),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id: ID }) },
  );
}

const gravada = () => banco.tabelas.campaigns![0]!;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: ORG },
    user: { id: "eeeeeeee-0000-4000-8000-000000000001", idioma: "pt-BR" },
  } as never);
  banco = supabaseEmMemoria({ campaigns: [campanha()] });
  vi.mocked(createAdminClient).mockReturnValue(banco.cliente as never);
  vi.mocked(createClient).mockResolvedValue(banco.cliente as never);
});

describe("PATCH — o público mescla com o gravado (item 13)", () => {
  it("um filtro SEM funis/etapas mantém o funil e a etapa gravados", async () => {
    const res = await patch({ audience_filter: { com_alguma_tag: ["retorno"], limite: 50 } });

    expect(res.status).toBe(200);
    expect(gravada().audience_filter).toMatchObject({
      com_alguma_tag: ["retorno"],
      funis: [FUNIL],
      etapas: [ETAPA],
      limite: 50,
    });
  });

  it("funis vazio limpa o critério (é como a tela tira o funil)", async () => {
    const res = await patch({ audience_filter: { funis: [], etapas: [] } });

    expect(res.status).toBe(200);
    expect(gravada().audience_filter).toMatchObject({ funis: [], etapas: [], com_alguma_tag: ["vip"] });
  });

  it("tirar o último critério é recusado, e o gravado fica intacto", async () => {
    banco.tabelas.campaigns![0] = campanha({ audience_filter: { ...FILTRO_VAZIO, funis: [FUNIL] } });

    const res = await patch({ audience_filter: { funis: [] } });

    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toBe("Escolha pelo menos um critério de público.");
    expect(gravada().audience_filter).toMatchObject({ funis: [FUNIL] });
  });
});

describe("PATCH — a janela vale mesclada (item 18)", () => {
  it("só o início, sem fim gravado, é 422 com frase — nada é gravado", async () => {
    const res = await patch({ janela_inicio_hora: 9 });

    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toBe("Preencha as duas horas, ou deixe as duas em branco.");
    expect(gravada().janela_inicio_hora).toBeNull();
  });

  it("só o início, contra um fim gravado, passa", async () => {
    banco.tabelas.campaigns![0] = campanha({ janela_inicio_hora: 9, janela_fim_hora: 18 });

    const res = await patch({ janela_inicio_hora: 8 });

    expect(res.status).toBe(200);
    expect(gravada()).toMatchObject({ janela_inicio_hora: 8, janela_fim_hora: 18 });
  });

  it("intervalo 0 diz qual é o mínimo", async () => {
    const res = await patch({ intervalo_segundos: 0 });

    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toBe("Use pelo menos 1 segundo.");
  });
});

describe("GET — a janela que vale agora (item 23)", () => {
  it("cruza a janela do número com a da campanha", async () => {
    banco.tabelas.campaigns![0] = campanha({ janela_inicio_hora: 9, janela_fim_hora: 23 });

    const res = await GET(new NextRequest(`http://localhost/api/v1/campaigns/${ID}`), {
      params: Promise.resolve({ id: ID }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data.janela_de_envio).toMatchObject({ inicio: 9, fim: 22 });
  });
});
