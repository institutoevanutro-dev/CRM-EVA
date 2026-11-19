/**
 * O RETORNO da ferramenta diz ao modelo se gravou ou se ficou pendente, e a
 * auditoria do cadastro gravado leva o CAMPO, nunca o valor (nem o CPF
 * mascarado). Dados fictícios.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as PropostaDeDado from "@/lib/contacts/proposta-de-dado";

const { audit, proporDadoDoContato } = vi.hoisted(() => ({
  audit: vi.fn(async (_e: unknown) => undefined),
  proporDadoDoContato: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ audit }));
vi.mock("@/lib/contacts/proposta-de-dado", async (original) => ({
  ...(await original<typeof PropostaDeDado>()),
  proporDadoDoContato,
}));

const { crmProposeContactField } = await import("@/lib/mcp/tools/contacts");

const CTX = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  role: "agent",
  actor: { type: "ai_agent", id: "run-1", agent_id: null, role: "agent" },
  requestId: "req-1",
  supabase: {},
} as never;
const CONTATO = "33333333-3333-4333-8333-333333333333";

describe("crm_propose_contact_field — cadastro de ficha vazia", () => {
  beforeEach(() => {
    audit.mockClear();
    proporDadoDoContato.mockReset();
  });

  it("gravado: motivo aplicado_automaticamente, e a auditoria sem o CPF", async () => {
    proporDadoDoContato.mockResolvedValue({
      criada: false,
      motivo: "aplicado_automaticamente",
      campo: "cpf",
      valor: "•••.•••.•••-25",
    });
    const r = (await crmProposeContactField.handler(
      { contact_id: CONTATO, campo: "cpf", valor: "529.982.247-25", trecho: "meu cpf 529.982.247-25" },
      CTX,
    )) as Record<string, unknown>;

    expect(r).toMatchObject({ proposta_criada: false, motivo: "aplicado_automaticamente", campo: "cpf" });
    expect(String(r.mensagem)).toContain("GRAVADO");
    const e = audit.mock.calls[0]![0] as { action: string; metadata: Record<string, unknown> };
    expect(e.action).toBe("contact.field_auto_applied");
    expect(e.metadata).toMatchObject({ campo: "cpf", automatico: true, origem: "cadastro_de_ficha_vazia" });
    expect(JSON.stringify(e)).not.toMatch(/529|•••|-25/);
  });

  it("pendente: proposta criada, e a mensagem manda NÃO dizer que atualizou", async () => {
    proporDadoDoContato.mockResolvedValue({ criada: true, id: "44444444-4444-4444-8444-444444444444", valorAnterior: null });
    const r = (await crmProposeContactField.handler(
      { contact_id: CONTATO, campo: "name", valor: "Joana Teste Silva" },
      CTX,
    )) as Record<string, unknown>;
    expect(r).toMatchObject({ proposta_criada: true, aguardando: "confirmação de uma pessoa" });
    expect(String(r.mensagem)).toContain("NÃO diga");
  });

  it("a descrição vista pelo modelo fala dos dois modos", () => {
    const d = crmProposeContactField.description;
    expect(d).toContain("aplicado_automaticamente");
    expect(d).toContain("VAZIO");
    expect(d).toMatch(/nunca é substituído/);
  });
});
