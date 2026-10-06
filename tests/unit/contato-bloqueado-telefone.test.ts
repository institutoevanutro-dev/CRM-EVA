import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";

/**
 * EDITAR A FICHA DE UM CONTATO BLOQUEADO: O TELEFONE NÃO MUDA, E A TELA SABE POR QUÊ.
 *
 * A migration 0319 passou a recusar, no banco, que a sessão mude o telefone (ou
 * o identificador do WhatsApp) de um contato bloqueado: soltar o telefone da
 * ficha desfazia o pedido de "parem de me escrever" sem desbloquear ninguém
 * (tests/invariants/bloqueio-acompanha-o-telefone.test.ts).
 *
 * O que se mede aqui é o que a ROTA faz com isso, porque um 42501 cru viraria
 * 500 "o sistema quebrou" num desfecho previsto:
 *
 *   1. telefone realmente diferente → 409 com a explicação, sem tocar no banco;
 *   2. o MESMO número escrito de outro jeito → não é mudança. O formulário
 *      reenvia o telefone a cada gravação, já normalizado; sem isto, corrigir o
 *      nome de um contato bloqueado cujo telefone foi gravado sem o nono dígito
 *      seria recusado por uma troca que ninguém fez;
 *   3. se a recusa vier do banco (uma integração que mande `source_metadata`, ou
 *      o contato ser bloqueado entre a leitura e a gravação) → o mesmo 409.
 */

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));

const ORG = "b10c0000-0000-4000-8000-000000000001";
const CONTATO = "b10c0000-0000-4000-8000-0000000000c1";
const USUARIO = "b10c0000-0000-4000-8000-0000000000a1";

let estadoAtual: Record<string, unknown>;
let gravado: Record<string, unknown> | null;
let erroDoBanco: { code: string; message: string } | null;

function clienteFalso(): unknown {
  return {
    from: () => ({
      select: () => {
        const chain = { eq: () => chain, maybeSingle: async () => ({ data: estadoAtual, error: null }) };
        return chain;
      },
      update: (patch: Record<string, unknown>) => {
        gravado = patch;
        const chain = {
          eq: () => chain,
          select: () => chain,
          maybeSingle: async () =>
            erroDoBanco
              ? { data: null, error: erroDoBanco }
              : { data: { ...estadoAtual, ...patch }, error: null },
        };
        return chain;
      },
    }),
    rpc: () => ({ then: (r: (v: unknown) => unknown) => r({ error: null }) }),
  };
}

async function patch(input: Record<string, unknown>): Promise<unknown> {
  const { patchContactHandler } = await import("@/app/api/v1/contacts/_handler");
  try {
    return await patchContactHandler(
      clienteFalso() as never,
      { organization_id: ORG, actor: { type: "user", id: USUARIO }, requestId: "req-1" },
      CONTATO,
      input as never,
    );
  } catch (err) {
    return err;
  }
}

beforeEach(() => {
  gravado = null;
  erroDoBanco = null;
  estadoAtual = {
    id: CONTATO,
    organization_id: ORG,
    is_anonymized: false,
    is_blocked: true,
    tags: [],
    email: null,
    phone_number: "+5531988887777",
    name: "Paciente",
    display_name: "Paciente",
    consent: {},
  };
});

describe("PATCH de contato BLOQUEADO", () => {
  it("telefone diferente → 409 com a explicação, e nada é gravado", async () => {
    const erro = await patch({ name: "Paciente", phone_number: "+5531900001111" });
    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).status).toBe(409);
    expect((erro as ApiError).code).toBe("state_conflict");
    expect((erro as ApiError).message).toMatch(/pediu para não receber mensagens/);
    expect(gravado, "a rota tentou gravar mesmo assim").toBeNull();
  });

  it("apagar o telefone também é mudar → 409", async () => {
    const erro = await patch({ phone_number: null });
    expect((erro as ApiError).status).toBe(409);
    expect(gravado).toBeNull();
  });

  it("o MESMO número em outra grafia não é mudança: grava o resto e não toca no telefone", async () => {
    // Gravado sem o nono dígito (contato antigo); o formulário devolve com ele.
    estadoAtual.phone_number = "+553188887777";
    const resultado = await patch({ name: "Nome corrigido", phone_number: "+5531988887777" });
    expect(resultado).not.toBeInstanceOf(Error);
    expect(gravado?.name).toBe("Nome corrigido");
    expect(gravado).not.toHaveProperty("phone_number");
  });

  it("os outros campos seguem editáveis", async () => {
    const resultado = await patch({ name: "Nome corrigido", email: "p@exemplo.com" });
    expect(resultado).not.toBeInstanceOf(Error);
    expect(gravado?.email).toBe("p@exemplo.com");
  });

  it("a recusa que vem do BANCO vira o mesmo 409, não um 500", async () => {
    erroDoBanco = { code: "42501", message: "contato_bloqueado_identidade_so_o_servidor" };
    const erro = await patch({ source_metadata: { origem: "integração" } });
    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).status).toBe(409);
    expect((erro as ApiError).code).toBe("state_conflict");
  });
});

describe("PATCH de contato que NÃO está bloqueado", () => {
  it("troca o telefone normalmente", async () => {
    estadoAtual.is_blocked = false;
    const resultado = await patch({ phone_number: "+5531900001111" });
    expect(resultado).not.toBeInstanceOf(Error);
    expect(gravado?.phone_number).toBe("+5531900001111");
  });

  it("outro erro do banco continua sendo 500", async () => {
    estadoAtual.is_blocked = false;
    erroDoBanco = { code: "XX000", message: "falha qualquer" };
    const erro = await patch({ name: "X" });
    expect((erro as ApiError).status).toBe(500);
  });
});
