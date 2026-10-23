import { describe, expect, it } from "vitest";

import {
  AI_ALLOWLIST_TTL_DAYS_DEFAULT,
  decidirElegibilidade,
  lerModoDoGate,
  montarEstadoDeElegibilidade,
  ttlDaAutorizacaoMs,
  type EstadoDeElegibilidade,
} from "./gate";

const AGORA = new Date("2026-08-27T12:00:00Z");
const DIA = 24 * 60 * 60 * 1000;

const base: EstadoDeElegibilidade = {
  contatoOculto: false,
  modo: "open",
  forceHuman: false,
  contatoInterno: false,
  botSilencedUntil: null,
  assigneeKind: "ai",
  aiAuthorizedAt: null,
  preGoLiveAtivo: false,
  numeroDeTesteAutorizado: false,
  agora: AGORA,
  ttlMs: 21 * DIA,
};

describe("decidirElegibilidade — contato oculto do Inbox (migration 0372)", () => {
  it("cala a IA em qualquer modo, antes de qualquer outra regra, e cala também o envio", () => {
    for (const estado of [
      { ...base, modo: "open" as const },
      { ...base, modo: "allowlist" as const, aiAuthorizedAt: AGORA },
      { ...base, modo: "allowlist" as const, preGoLiveAtivo: true, numeroDeTesteAutorizado: true },
      { ...base, forceHuman: true },
    ]) {
      expect(decidirElegibilidade({ ...estado, contatoOculto: true })).toEqual({
        permite: false,
        motivo: "contato_oculto",
        // Veto de pessoa, e não de allowlist: o sink de envio (pessoaNoComandoDaConversa)
        // lê só estes, bolha a bolha.
        bloqueioPorAllowlist: false,
      });
    }
  });

  it("visível, nada muda", () => {
    expect(decidirElegibilidade({ ...base, contatoOculto: false }).permite).toBe(true);
  });
});

describe("lerModoDoGate", () => {
  it("só 'allowlist' liga o modo; resto (ausente/null/lixo) é 'open'", () => {
    expect(lerModoDoGate("allowlist")).toBe("allowlist");
    expect(lerModoDoGate("open")).toBe("open");
    expect(lerModoDoGate(undefined)).toBe("open");
    expect(lerModoDoGate(null)).toBe("open");
    expect(lerModoDoGate("ALLOWLIST")).toBe("open");
    expect(lerModoDoGate(42)).toBe("open");
  });
});

describe("decidirElegibilidade — gate 'open' (comportamento de hoje)", () => {
  it("mensagem genérica sem autorização: PERMITE (nada muda para quem não configurou)", () => {
    const d = decidirElegibilidade({ ...base, modo: "open" });
    expect(d.permite).toBe(true);
    expect(d.motivo).toBe("gate_aberto");
  });

  it("force_human bloqueia mesmo com gate aberto", () => {
    const d = decidirElegibilidade({ ...base, modo: "open", forceHuman: true });
    expect(d.permite).toBe(false);
    expect(d.motivo).toBe("force_human");
    expect(d.bloqueioPorAllowlist).toBe(false);
  });

  it("conversa com dono humano bloqueia mesmo com gate aberto", () => {
    const d = decidirElegibilidade({ ...base, modo: "open", assigneeKind: "user" });
    expect(d.permite).toBe(false);
    expect(d.motivo).toBe("conversa_de_humano");
  });

  it("bot silenciado até o futuro bloqueia; silêncio no passado não", () => {
    expect(
      decidirElegibilidade({ ...base, modo: "open", botSilencedUntil: new Date(AGORA.getTime() + DIA) }).permite,
    ).toBe(false);
    expect(
      decidirElegibilidade({ ...base, modo: "open", botSilencedUntil: new Date(AGORA.getTime() - DIA) }).permite,
    ).toBe(true);
    expect(
      decidirElegibilidade({ ...base, modo: "open", botSilencedUntil: Number.POSITIVE_INFINITY }).permite,
    ).toBe(false);
  });
});

describe("decidirElegibilidade — gate 'allowlist' (deny by default)", () => {
  it("teste 1/3/4/9: mensagem comum de contato NÃO autorizado → NÃO responde", () => {
    const d = decidirElegibilidade({ ...base, modo: "allowlist", aiAuthorizedAt: null });
    expect(d.permite).toBe(false);
    expect(d.motivo).toBe("sem_autorizacao");
    expect(d.bloqueioPorAllowlist).toBe(true);
  });

  it("teste 6/7: contato autorizado dentro da janela → responde", () => {
    const d = decidirElegibilidade({
      ...base,
      modo: "allowlist",
      aiAuthorizedAt: new Date(AGORA.getTime() - 3 * DIA),
    });
    expect(d.permite).toBe(true);
    expect(d.motivo).toBe("autorizado");
  });

  it("submissão antiga (fora da janela) NÃO reativa a IA", () => {
    const d = decidirElegibilidade({
      ...base,
      modo: "allowlist",
      aiAuthorizedAt: new Date(AGORA.getTime() - 30 * DIA),
      ttlMs: 21 * DIA,
    });
    expect(d.permite).toBe(false);
    expect(d.motivo).toBe("autorizacao_expirada");
    expect(d.bloqueioPorAllowlist).toBe(true);
  });

  it("teste 10: conversa marcada human_only (force_human) → nunca responde, mesmo autorizada", () => {
    const d = decidirElegibilidade({
      ...base,
      modo: "allowlist",
      forceHuman: true,
      aiAuthorizedAt: new Date(AGORA.getTime() - DIA),
    });
    expect(d.permite).toBe(false);
    expect(d.motivo).toBe("force_human");
  });

  it("teste 2: conversa aberta e autorizada → responde (estado da conversa não pesa)", () => {
    const d = decidirElegibilidade({
      ...base,
      modo: "allowlist",
      assigneeKind: "ai",
      aiAuthorizedAt: new Date(AGORA.getTime() - DIA),
    });
    expect(d.permite).toBe(true);
  });
});

describe("decidirElegibilidade — pré-go-live", () => {
  it("permite o número escolhido mesmo sem autorização global", () => {
    const d = decidirElegibilidade({
      ...base,
      modo: "allowlist",
      preGoLiveAtivo: true,
      numeroDeTesteAutorizado: true,
      aiAuthorizedAt: null,
    });
    expect(d).toEqual({
      permite: true,
      motivo: "numero_de_teste",
      bloqueioPorAllowlist: false,
    });
  });

  it("barra quem está fora da lista mesmo que uma campanha já tenha autorizado", () => {
    const d = decidirElegibilidade({
      ...base,
      modo: "allowlist",
      preGoLiveAtivo: true,
      numeroDeTesteAutorizado: false,
      aiAuthorizedAt: AGORA,
    });
    expect(d).toEqual({
      permite: false,
      motivo: "fora_da_lista_de_teste",
      bloqueioPorAllowlist: true,
    });
  });

  it("vetos humanos continuam acima da lista de teste", () => {
    const d = decidirElegibilidade({
      ...base,
      modo: "allowlist",
      preGoLiveAtivo: true,
      numeroDeTesteAutorizado: true,
      forceHuman: true,
    });
    expect(d.motivo).toBe("force_human");
  });
});

describe("ttlDaAutorizacaoMs", () => {
  it("default quando ausente/vazio/inválido/zero/negativo", () => {
    const esperado = AI_ALLOWLIST_TTL_DAYS_DEFAULT * DIA;
    expect(ttlDaAutorizacaoMs({})).toBe(esperado);
    expect(ttlDaAutorizacaoMs({ AI_ALLOWLIST_TTL_DAYS: "" })).toBe(esperado);
    expect(ttlDaAutorizacaoMs({ AI_ALLOWLIST_TTL_DAYS: "abc" })).toBe(esperado);
    expect(ttlDaAutorizacaoMs({ AI_ALLOWLIST_TTL_DAYS: "0" })).toBe(esperado);
    expect(ttlDaAutorizacaoMs({ AI_ALLOWLIST_TTL_DAYS: "-5" })).toBe(esperado);
  });
  it("respeita o valor configurado", () => {
    expect(ttlDaAutorizacaoMs({ AI_ALLOWLIST_TTL_DAYS: "7" })).toBe(7 * DIA);
  });
});

describe("#2353 do original · contato interno não é atendido pela IA", () => {
  it("contato interno → NÃO responde, com motivo 'contato_interno' e sem bloqueio por allowlist", () => {
    const d = decidirElegibilidade({ ...base, modo: "open", contatoInterno: true });
    expect(d).toEqual({ permite: false, motivo: "contato_interno", bloqueioPorAllowlist: false });
  });

  it("como 'Assumir' (conversa_de_humano), o bloqueioPorAllowlist é false: não gasta job nem vira erro", () => {
    const interno = decidirElegibilidade({ ...base, modo: "allowlist", contatoInterno: true });
    const humano = decidirElegibilidade({ ...base, modo: "allowlist", assigneeKind: "user" });
    expect(interno.bloqueioPorAllowlist).toBe(humano.bloqueioPorAllowlist);
    expect(interno.bloqueioPorAllowlist).toBe(false);
  });

  it("ordem declarada: um veto mais duro (force_human) vence o contato interno", () => {
    const d = decidirElegibilidade({ ...base, modo: "open", contatoInterno: true, forceHuman: true });
    expect(d.motivo).toBe("force_human");
  });

  it("regressão: contato SEM a tag segue sendo atendido com o gate aberto", () => {
    const d = decidirElegibilidade({ ...base, modo: "open", contatoInterno: false });
    expect(d).toEqual({ permite: true, motivo: "gate_aberto", bloqueioPorAllowlist: false });
  });

  const montar = (extra: { contactTags?: string[]; orgSettings?: unknown; tagsInternas?: string[] }) =>
    montarEstadoDeElegibilidade({
      aiGate: "open",
      forceHuman: false,
      assigneeKind: null,
      botSilencedUntil: null,
      aiAuthorizedAt: null,
      agora: AGORA,
      ttlMs: DIA,
      ...extra,
    });

  it("montarEstadoDeElegibilidade: a tag interna cruza com settings.crm.internal_contact_tags", () => {
    expect(montar({ contactTags: [" Interno "], orgSettings: { crm: { internal_contact_tags: ["interno"] } } }).contatoInterno).toBe(true);
    expect(montar({ contactTags: ["interno"], orgSettings: {} }).contatoInterno).toBe(false);
    expect(montar({ contactTags: ["interno"], orgSettings: { crm: { internal_contact_tags: "interno" } } }).contatoInterno).toBe(false);
    // Sem a leitura (meet, chamador antigo), ninguém é interno: o comportamento de antes.
    expect(montar({ contactTags: ["interno"] }).contatoInterno).toBe(false);
  });

  it("a lista já lida (`tagsInternas`) vence o settings, para quem decide muitos contatos da mesma org", () => {
    expect(montar({ contactTags: ["equipe"], tagsInternas: ["equipe"], orgSettings: {} }).contatoInterno).toBe(true);
  });
});
