/**
 * VER O CPF DE UM CONTATO — quem pode, por onde passa, e o que fica registrado.
 *
 * O CPF é guardado cifrado (migration 0274) e lido por `decrypt_cpf` (0275),
 * que **só a service key executa**. O handler é a única porta: ele já leu a
 * ficha filtrando por organização, confere o papel de quem pede e registra a
 * consulta. As três coisas são testadas aqui porque cada uma, sozinha, é
 * insuficiente — e a do meio é a que um refactor apaga sem perceber.
 *
 * Decisão de produto (22/09/2026, dono do produto): o piso é **atendente**;
 * visualizador vê que existe CPF e não o número. Sem pedir motivo — o registro
 * de quem viu é a prestação de contas.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HandlerCtx } from "@/lib/api/handlers/types";

const auditSpy = vi.fn(async () => undefined);
vi.mock("@/lib/audit", () => ({
  audit: auditSpy,
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));

const adminRpc = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: adminRpc }),
}));

const { getContactHandler } = await import("@/app/api/v1/contacts/_handler");

const ORG = "cf1cf001-0000-4000-8000-000000000001";
const CONTATO = "cf1cf001-0000-4000-8000-0000000000c1";
const USUARIO = "cf1cf001-0000-4000-8000-0000000000a1";
const CPF = "52998224725";

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: USUARIO },
  requestId: "req-cpf-ver",
  idioma: "pt-BR",
};

/** Client de sessão: devolve a ficha e o papel de quem pede. */
function banco(papel: string, comCpf = true) {
  const rpc = vi.fn(async () => ({ data: null, error: null }));
  const from = vi.fn((tabela: string) => {
    const q: Record<string, unknown> = {};
    const self = () => q;
    for (const m of ["select", "eq", "is", "in", "order", "limit", "not", "or", "gte"]) {
      q[m] = vi.fn(self);
    }
    // A consulta de conversas do contato é aguardada direto (sem `single`).
    q.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
    q.maybeSingle = vi.fn(async () =>
      tabela === "user_organizations"
        ? { data: { role: papel }, error: null }
        : {
            data: {
              id: CONTATO,
              organization_id: ORG,
              name: "Paciente",
              source: "manual",
              cpf_hash: comCpf ? "a".repeat(64) : null,
            },
            error: null,
          },
    );
    return q;
  });
  return { from, rpc } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  adminRpc.mockResolvedValue({ data: CPF, error: null });
});

describe("ver o CPF na ficha", () => {
  it("atendente vê o CPF, e a consulta é decifrada pela service key", async () => {
    const r = await getContactHandler(banco("agent"), ctx, {
      contactId: CONTATO,
      decryptPurpose: "ficha",
    } as never);

    expect(r.cpf_decrypted).toBe(CPF);
    expect(r.cpf_decrypt_denied).toBeUndefined();
    expect(adminRpc).toHaveBeenCalledExactlyOnceWith("decrypt_cpf", { p_contact_id: CONTATO });
  });

  it("gerente e administrador também veem", async () => {
    for (const papel of ["manager", "admin"]) {
      vi.clearAllMocks();
      adminRpc.mockResolvedValue({ data: CPF, error: null });
      const r = await getContactHandler(banco(papel), ctx, {
        contactId: CONTATO,
        decryptPurpose: "ficha",
      } as never);
      expect(r.cpf_decrypted, papel).toBe(CPF);
    }
  });

  it("visualizador é recusado e NADA é decifrado", async () => {
    const r = await getContactHandler(banco("viewer"), ctx, {
      contactId: CONTATO,
      decryptPurpose: "ficha",
    } as never);

    expect(r.cpf_decrypted).toBeNull();
    expect(r.cpf_decrypt_denied).toBe(true);
    expect(r.cpf_available).toBe(true); // sabe que existe; não vê o número
    expect(adminRpc).not.toHaveBeenCalled();
  });

  it("a consulta fica registrada como leitura, não como alteração", async () => {
    await getContactHandler(banco("agent"), ctx, {
      contactId: CONTATO,
      decryptPurpose: "ficha",
    } as never);

    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "contact.cpf_viewed",
        organizationId: ORG,
        resourceId: CONTATO,
        actorUserId: USUARIO,
      }),
    );
  });

  it("sem pedir para ver, nada é decifrado nem registrado", async () => {
    const r = await getContactHandler(banco("admin"), ctx, {
      contactId: CONTATO,
      decryptPurpose: null,
    } as never);

    expect(r.cpf_decrypted).toBeNull();
    expect(r.cpf_available).toBe(true);
    expect(adminRpc).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });
});
