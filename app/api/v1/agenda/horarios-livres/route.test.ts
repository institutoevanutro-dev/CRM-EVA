/**
 * GET /api/v1/agenda/horarios-livres: a unidade pedida chega à consulta, e cada
 * horário volta com a unidade que a consulta deu a ele.
 *
 * Medido em produção (14/10/2026): `unit_id=<Serra>` devolvia os MESMOS 63
 * horários de sem filtro, porque o parâmetro nunca entrava no `safeParse`; e
 * todo horário saía com `unit_id: null`, porque a rota ecoava o que foi pedido
 * em vez da unidade do horário.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";
import { horariosLivresDaOrg } from "@/lib/agenda/consulta";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/agenda/consulta", () => ({ horariosLivresDaOrg: vi.fn(), MAXIMO_DE_DIAS: 62 }));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const TIPO = "44444444-4444-4444-8444-444444444444";
const VITORIA = "ea730000-0000-4000-8000-000000000001";
const SERRA = "ea730000-0000-4000-8000-000000000002";

beforeEach(() => {
  vi.clearAllMocks();
  const user: AuthUser = {
    id: USER,
    email: "viewer@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG, organization_name: "Org", role: "viewer" }],
  };
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user, org: { orgId: ORG, name: "Org", role: "viewer" } });
  vi.mocked(horariosLivresDaOrg).mockResolvedValue({
    ok: true,
    slots: [
      {
        inicio: new Date("2026-10-15T13:00:00Z"),
        fim: new Date("2026-10-15T13:50:00Z"),
        unitId: VITORIA,
      },
      { inicio: new Date("2026-10-15T13:50:00Z"), fim: new Date("2026-10-15T14:40:00Z"), unitId: null },
    ],
    fusoDaRegra: "America/Sao_Paulo",
    publicouHorarios: true,
    fusoSuposto: false,
    fontesDefasadas: [],
    agendaExternaNuncaLida: false,
    googleCoberturaParcial: false,
    nomesDasUnidades: {},
  });
});

function pedir(extra = ""): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/agenda/horarios-livres?event_type_id=${TIPO}` +
      `&de=2026-10-15T00:00:00Z&ate=2026-10-16T00:00:00Z${extra}`,
  );
}

describe("GET /api/v1/agenda/horarios-livres e a unidade", () => {
  it("a unidade pedida chega à consulta", async () => {
    const { GET } = await import("./route");
    const res = await GET(pedir(`&unit_id=${SERRA}`));
    expect(res.status).toBe(200);
    expect(vi.mocked(horariosLivresDaOrg).mock.calls[0]?.[2]).toMatchObject({ unitId: SERRA });
  });

  it("cada horário volta com a unidade da janela que o gerou, não com a pedida", async () => {
    const { GET } = await import("./route");
    const res = await GET(pedir());
    const corpo = (await res.json()) as { data: { slots: Array<{ unit_id: string | null }> } };
    expect(corpo.data.slots.map((s) => s.unit_id)).toEqual([VITORIA, null]);
  });
});
