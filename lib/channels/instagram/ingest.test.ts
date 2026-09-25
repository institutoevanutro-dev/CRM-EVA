import { describe, expect, it, vi } from "vitest";
import type { EventoDoInstagram } from "./webhook";

vi.mock("./graph", () => ({ perfilDoRemetente: vi.fn(async () => ({ nome: "Maria", handle: "maria", foto: null })) }));
vi.mock("../marcar-conversa", () => ({ marcarConversaComMensagem: vi.fn(async () => undefined) }));
vi.mock("../pos-entrada", () => ({ aplicarEfeitosPosEntrada: vi.fn(async () => undefined) }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: async () => "TOKEN" }));

const { ingerirDoInstagram } = await import("./ingest");
const { aplicarEfeitosPosEntrada } = await import("../pos-entrada");

function adminFalso(opts: { insertErro?: { code: string; message: string } | null; contatoNovo?: boolean }) {
  const chamadas: Record<"rpc" | "insert" | "update", [string, unknown][]> = { rpc: [], insert: [], update: [] };
  const admin = {
    rpc: vi.fn(async (nome: string, args: unknown) => {
      chamadas.rpc.push([nome, args]);
      if (nome === "fn_upsert_contato_por_identidade") return { data: [{ contact_id: "C1", criado: opts.contatoNovo ?? true }], error: null };
      if (nome === "fn_upsert_conversa_de_canal") return { data: "CV1", error: null };
      return { data: null, error: null };
    }),
    from: vi.fn((tabela: string) => ({
      insert: (linha: unknown) => { chamadas.insert.push([tabela, linha]); return { select: () => ({ maybeSingle: async () => opts.insertErro ? { data: null, error: opts.insertErro } : { data: { id: "M1" }, error: null } }) }; },
      update: (linha: unknown) => { chamadas.update.push([tabela, linha]); return { eq: () => ({ eq: async () => ({ error: null }) }) }; },
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { custom_fields: {} }, error: null }) }) }) }),
    })),
  };
  return { admin, chamadas };
}

const sessao = { id: "S1", organizationId: "ORG", igAccountId: "IGACC", tokenCifrado: "x", origemPadrao: { campo: "origem", valor: "Instagram Dr. André" } };
const evento = (over: Partial<EventoDoInstagram> = {}): EventoDoInstagram => ({ igAccountId: "IGACC", remetente: "IGSID9", destinatario: "IGACC", externalId: "m1", eco: false, texto: "Oi", anexos: [], enviadaEm: new Date(1), ...over });

describe("ingestão do Instagram", () => {
  it("mensagem nova grava inbound com canal instagram e aplica a origem padrão no contato novo", async () => {
    const { admin, chamadas } = adminFalso({});
    const r = await ingerirDoInstagram(admin as never, evento(), sessao);
    expect(r).toMatchObject({ status: "ingerida", contatoNovo: true });
    expect(chamadas.rpc).toContainEqual(["fn_upsert_conversa_de_canal", { p_org: "ORG", p_contact: "C1", p_session: "S1", p_canal: "instagram" }]);
    const [, msg] = chamadas.insert.find(([t]) => t === "messages") as [string, Record<string, unknown>];
    expect(msg).toMatchObject({ organization_id: "ORG", direction: "inbound", external_id: "m1", body: "Oi" });
    expect(chamadas.update).toContainEqual(["contacts", { custom_fields: { origem: "Instagram Dr. André" } }]);
    expect(aplicarEfeitosPosEntrada).toHaveBeenCalled();
  });

  it("entrega repetida (23505) é duplicada, sem efeitos", async () => {
    vi.mocked(aplicarEfeitosPosEntrada).mockClear();
    const { admin } = adminFalso({ insertErro: { code: "23505", message: "dup" } });
    expect(await ingerirDoInstagram(admin as never, evento(), sessao)).toEqual({ status: "duplicada" });
    expect(aplicarEfeitosPosEntrada).not.toHaveBeenCalled();
  });

  it("eco entra como outbound, identifica o contato pelo destinatário e não dispara efeitos de entrada", async () => {
    vi.mocked(aplicarEfeitosPosEntrada).mockClear();
    const { admin, chamadas } = adminFalso({ contatoNovo: false });
    await ingerirDoInstagram(admin as never, evento({ eco: true, remetente: "IGACC", destinatario: "IGSID9" }), sessao);
    const [, args] = chamadas.rpc.find(([n]) => n === "fn_upsert_contato_por_identidade") as [string, Record<string, unknown>];
    expect(args.p_external_id).toBe("IGSID9");
    const [, msg] = chamadas.insert.find(([t]) => t === "messages") as [string, Record<string, unknown>];
    expect(msg.direction).toBe("outbound");
    expect(aplicarEfeitosPosEntrada).not.toHaveBeenCalled();
  });
});
