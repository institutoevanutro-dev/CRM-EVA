import { describe, expect, it, vi } from "vitest";
import type { EventoDoInstagram } from "./webhook";

const perfilDoRemetenteMock = vi.fn(async () => ({ nome: "Maria", handle: "maria", foto: null }));
vi.mock("./graph", () => ({ perfilDoRemetente: (...a: unknown[]) => perfilDoRemetenteMock(...(a as [])) }));
vi.mock("../marcar-conversa", () => ({ marcarConversaComMensagem: vi.fn(async () => undefined) }));
vi.mock("../pos-entrada", () => ({ aplicarEfeitosPosEntrada: vi.fn(async () => undefined) }));
const decryptWebhookSecretMock = vi.fn(async () => "TOKEN");
vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: (...a: unknown[]) => decryptWebhookSecretMock(...(a as [])),
}));
const loggerWarnMock = vi.fn();
vi.mock("@/lib/logger", () => ({ logger: { warn: (...a: unknown[]) => loggerWarnMock(...a), info: vi.fn(), error: vi.fn() } }));

const { ingerirDoInstagram } = await import("./ingest");
const { aplicarEfeitosPosEntrada } = await import("../pos-entrada");

function adminFalso(opts: {
  insertErro?: { code: string; message: string } | null;
  contatoNovo?: boolean;
  identidadeExistente?: boolean;
  updateErro?: { message: string } | null;
}) {
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
      update: (linha: unknown) => {
        chamadas.update.push([tabela, linha]);
        return { eq: () => ({ eq: async () => ({ error: opts.updateErro ?? null }) }) };
      },
      // Tabela-consciente e encadeável para QUALQUER número de `.eq()`: o
      // check de identidade (`contact_channel_identities`) usa três, a leitura
      // de `custom_fields` (`contacts`) usa dois.
      select: () => {
        const chain: { eq: () => typeof chain; maybeSingle: () => Promise<{ data: unknown; error: null }> } = {
          eq: () => chain,
          maybeSingle: async () =>
            tabela === "contact_channel_identities"
              ? { data: opts.identidadeExistente ? { contact_id: "C1" } : null, error: null }
              : { data: { custom_fields: {} }, error: null },
        };
        return chain;
      },
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
    // Escrita no app do Instagram, não no CRM: mesma marca do WAHA para o
    // `fromMe` de outro aparelho. A bolha diz de onde saiu, e nada que conte
    // resposta do CRM (`sent_via in ('ai','user')`) a confunde com uma.
    expect(msg.sent_via).toBe("external_device");
    expect(msg.metadata).toMatchObject({ fromMe: true, eco_do_app: true });
    expect(aplicarEfeitosPosEntrada).not.toHaveBeenCalled();
  });

  it("anexo emite media.persist_requested para o worker baixar do CDN do Instagram", async () => {
    const { admin, chamadas } = adminFalso({});
    const r = await ingerirDoInstagram(
      admin as never,
      evento({ texto: null, anexos: [{ tipo: "image", url: "https://scontent.cdninstagram.com/foto.jpg" }] }),
      sessao,
    );
    expect(r).toMatchObject({ status: "ingerida" });
    const emit = chamadas.rpc.find(([n, a]) => n === "emit_event" && (a as Record<string, unknown>).p_event_type === "media.persist_requested");
    expect(emit).toBeTruthy();
    const [, args] = emit as [string, Record<string, unknown>];
    expect(args.p_payload).toMatchObject({ message_id: "M1", conversation_id: "CV1" });
  });

  it("identidade já cadastrada não chama a Graph nem decifra o token (só na primeira vez)", async () => {
    perfilDoRemetenteMock.mockClear();
    decryptWebhookSecretMock.mockClear();
    const { admin } = adminFalso({ identidadeExistente: true, contatoNovo: false });
    const r = await ingerirDoInstagram(admin as never, evento(), sessao);
    expect(r).toMatchObject({ status: "ingerida" });
    expect(decryptWebhookSecretMock).not.toHaveBeenCalled();
    expect(perfilDoRemetenteMock).not.toHaveBeenCalled();
  });

  it("identidade nova decifra o token e chama a Graph", async () => {
    perfilDoRemetenteMock.mockClear();
    decryptWebhookSecretMock.mockClear();
    const { admin } = adminFalso({ identidadeExistente: false });
    await ingerirDoInstagram(admin as never, evento(), sessao);
    expect(decryptWebhookSecretMock).toHaveBeenCalled();
    expect(perfilDoRemetenteMock).toHaveBeenCalled();
  });

  it("falha ao gravar a origem padrão vira logger.warn, sem derrubar a ingestão", async () => {
    loggerWarnMock.mockClear();
    const { admin } = adminFalso({ updateErro: { message: "falhou o update" } });
    const r = await ingerirDoInstagram(admin as never, evento(), sessao);
    expect(r).toMatchObject({ status: "ingerida" });
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "[instagram.ingest] atualização da origem padrão falhou",
      expect.objectContaining({ organization_id: "ORG", contact_id: "C1", detail: "falhou o update" }),
    );
  });
});
