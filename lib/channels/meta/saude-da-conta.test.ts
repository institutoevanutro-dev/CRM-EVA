import { beforeEach, describe, expect, it, vi } from "vitest";

import { DETALHE_DESCONECTADO_NO_APP } from "@/lib/channels/health";

import { aplicarEventoDaConta } from "./saude-da-conta";
import type { AccountEvent } from "./webhook";

const sincronizar = vi.fn();
vi.mock("@/lib/channels/health", async (orig) => ({
  ...(await orig<typeof import("@/lib/channels/health")>()),
  sincronizarSaudeDaConexao: (...a: unknown[]) => sincronizar(...a),
}));

const SESSAO = { id: "sess-1", organizationId: "org-1", wabaId: "222" };
let escalado: string | null = null;
let erroDoUpdate: { message: string } | null = null;
const updates: Array<{ patch: Record<string, unknown>; filtros: Record<string, unknown> }> = [];

const admin = {
  from: (tabela: string) => {
    const filtros: Record<string, unknown> = {};
    let patch: Record<string, unknown> | null = null;
    const cadeia: Record<string, unknown> = {
      update: (p: Record<string, unknown>) => {
        patch = p;
        return cadeia;
      },
      select: () => cadeia,
      eq: (k: string, v: unknown) => {
        filtros[k] = v;
        return cadeia;
      },
      maybeSingle: async () => ({
        data: tabela === "channel_session_health" ? { escalated_status: escalado } : { display_name: "Clínica", phone_number: "+55" },
      }),
      then: (ok: (v: unknown) => unknown) => {
        if (patch) updates.push({ patch, filtros });
        return Promise.resolve({ error: erroDoUpdate }).then(ok);
      },
    };
    return cadeia;
  },
} as never;

const ev = (evento: AccountEvent["evento"], motivo: string | null = null): AccountEvent => ({
  kind: "account_event",
  wabaId: "222",
  evento,
  motivo,
  phoneNumber: null,
});

beforeEach(() => {
  updates.length = 0;
  escalado = "PUSH:DESCONECTADO_NO_APP";
  erroDoUpdate = null;
  sincronizar.mockReset();
});

describe("aplicarEventoDaConta", () => {
  it("PARTNER_REMOVED: sessão FAILED com status_reason e aviso pelo empurrão, com o motivo da Meta", async () => {
    expect(await aplicarEventoDaConta(admin, SESSAO, ev("PARTNER_REMOVED", "USER_INITIATED_DISCONNECT"))).toBe("caiu");
    expect(updates[0]?.patch).toMatchObject({ status: "FAILED", status_reason: "coexistencia_desconectada" });
    expect(sincronizar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: SESSAO.id, status: "FAILED" }),
      { reachable: false, status: null, detail: `${DETALHE_DESCONECTADO_NO_APP}:USER_INITIATED_DISCONNECT` },
      "Clínica",
      "empurrao",
    );
  });

  it("ACCOUNT_OFFBOARDED também derruba (mesmo caminho do PARTNER_REMOVED)", async () => {
    expect(await aplicarEventoDaConta(admin, SESSAO, ev("ACCOUNT_OFFBOARDED"))).toBe("caiu");
    expect(updates[0]?.patch).toMatchObject({ status: "FAILED", status_reason: "coexistencia_desconectada" });
    expect(sincronizar.mock.calls[0]![2]).toEqual({ reachable: false, status: null, detail: `${DETALHE_DESCONECTADO_NO_APP}:` });
  });

  it("ACCOUNT_RECONNECTED: WORKING, status_reason nulo, observação boa pelo empurrão (resolve o aviso)", async () => {
    expect(await aplicarEventoDaConta(admin, SESSAO, ev("ACCOUNT_RECONNECTED"))).toBe("voltou");
    expect(updates[0]?.patch).toMatchObject({ status: "WORKING", status_reason: null });
    expect(sincronizar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: SESSAO.id, status: "WORKING" }),
      { reachable: true, status: "WORKING", detail: null },
      "Clínica",
      "empurrao",
    );
  });

  it("evento desconhecido é ignorado sem tocar na sessão", async () => {
    expect(await aplicarEventoDaConta(admin, SESSAO, ev("OUTRO"))).toBe("ignorado");
    expect(updates).toHaveLength(0);
    expect(sincronizar).not.toHaveBeenCalled();
  });

  it("o update filtra organization_id e id (service role sem filtro de org é o anti-pattern 10)", async () => {
    await aplicarEventoDaConta(admin, SESSAO, ev("PARTNER_REMOVED"));
    expect(updates[0]?.filtros).toMatchObject({ organization_id: SESSAO.organizationId, id: SESSAO.id });
  });

  it("reconexão NÃO fecha outro episódio aberto (suspensão por empurrão, token vencido): só vira WORKING", async () => {
    for (const outro of ["PUSH:SUSPENSO", "TOKEN_DE_RENOVACAO_VENCIDO", null]) {
      sincronizar.mockReset();
      updates.length = 0;
      escalado = outro;
      expect(await aplicarEventoDaConta(admin, SESSAO, ev("ACCOUNT_RECONNECTED"))).toBe("voltou");
      expect(updates[0]?.patch).toMatchObject({ status: "WORKING", status_reason: null });
      expect(sincronizar, String(outro)).not.toHaveBeenCalled();
    }
  });

  it("erro no update: loga, não abre o aviso e não lança", async () => {
    erroDoUpdate = { message: "boom" };
    await expect(aplicarEventoDaConta(admin, SESSAO, ev("PARTNER_REMOVED"))).resolves.toBe("ignorado");
    expect(sincronizar).not.toHaveBeenCalled();
  });
});
