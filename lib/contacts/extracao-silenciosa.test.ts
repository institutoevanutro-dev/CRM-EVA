/**
 * Extração silenciosa de cadastro (migration 0407): a regra pura e o
 * orquestrador contra um dublê de Supabase que REGISTRA toda escrita — é assim
 * que "nenhuma mensagem enviada" e "nunca sobrescreve" viram asserção.
 * Nomes e números fictícios.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auditorias: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
vi.mock("@/lib/audit", () => ({
  audit: async (e: { action: string; metadata?: Record<string, unknown> }) => {
    auditorias.push(e);
  },
}));
// O CPF de proposta passa pelo client de serviço (cifra e índice).
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => dubleAtual }));

import {
  conversaDaEquipe,
  decidir,
  enderecoComparavel,
  extrairCadastroSilencioso,
  extrairCpf,
  extrairEmail,
  extrairNascimento,
  lerRespostaDoEndereco,
  temIndicioDeEndereco,
} from "./extracao-silenciosa";

const AGORA = new Date("2026-11-11T12:00:00Z");
// CPFs fictícios com dígitos verificadores válidos.
const CPF_A = "52998224725";
const CPF_B = "11144477735";

// ===========================================================================
// Regra pura
// ===========================================================================

describe("CPF", () => {
  it("aceita com e sem máscara, e valida os dígitos verificadores", () => {
    expect(extrairCpf("meu cpf 529.982.247-25")).toBe(CPF_A);
    expect(extrairCpf("CPF: 52998224725")).toBe(CPF_A);
    expect(extrairCpf("529.982.247-24")).toBeNull();
  });

  it("recusa sequência repetida", () => {
    expect(extrairCpf("111.111.111-11")).toBeNull();
    expect(extrairCpf("cpf 00000000000")).toBeNull();
  });

  it("11 dígitos colados só valem com a palavra CPF (na mensagem ou no pedido da equipe)", () => {
    expect(extrairCpf("52998224725")).toBeNull();
    expect(extrairCpf("52998224725", "Me manda seu CPF, por favor")).toBe(CPF_A);
  });

  it("dois CPFs diferentes na mesma mensagem é ambíguo", () => {
    expect(extrairCpf(`o meu 529.982.247-25 e do meu marido 111.444.777-35`)).toBeNull();
  });
});

describe("e-mail", () => {
  it("extrai e normaliza para minúsculo", () => {
    expect(extrairEmail("é Maria.Teste@Exemplo.com.br obrigada")).toBe("maria.teste@exemplo.com.br");
  });
  it("nenhum ou mais de um → null", () => {
    expect(extrairEmail("sem email aqui")).toBeNull();
    expect(extrairEmail("a@exemplo.com ou b@exemplo.com")).toBeNull();
  });
});

describe("data de nascimento", () => {
  it("formatos BR com a palavra nascimento", () => {
    expect(extrairNascimento("data de nascimento 10/03/1990", AGORA)).toBe("1990-03-10");
    expect(extrairNascimento("nasci em 10-03-1990", AGORA)).toBe("1990-03-10");
    expect(extrairNascimento("DN 10.03.90", AGORA)).toBe("1990-03-10");
  });

  it("data solta sem contexto de cadastro não é nascimento", () => {
    expect(extrairNascimento("pode ser dia 10/03/1990?", AGORA)).toBeNull();
  });

  it("vale pelo pedido da equipe logo antes", () => {
    expect(extrairNascimento("10/03/1990", AGORA, "Qual sua data de nascimento?")).toBe("1990-03-10");
  });

  it("bloco de cadastro (com CPF) vale sem a palavra, mas data recente não", () => {
    expect(extrairNascimento(`529.982.247-25 10/03/1990`, AGORA)).toBe("1990-03-10");
    expect(extrairNascimento(`529.982.247-25 01/11/2026`, AGORA)).toBeNull();
  });

  it("recusa data que não existe e data no futuro", () => {
    expect(extrairNascimento("nascimento 30/02/1990", AGORA)).toBeNull();
    expect(extrairNascimento("nascimento 10/03/2030", AGORA)).toBeNull();
  });
});

describe("indício de endereço e resposta do modelo", () => {
  it("CEP ou logradouro com número chamam o modelo; conversa comum não", () => {
    expect(temIndicioDeEndereco("CEP 29100-000")).toBe(true);
    expect(temIndicioDeEndereco("Rua das Flores, 100")).toBe(true);
    expect(temIndicioDeEndereco("ok, obrigada")).toBe(false);
    // CPF não é CEP.
    expect(temIndicioDeEndereco("529.982.247-25")).toBe(false);
  });

  it("lê só o JSON no formato; o resto é null", () => {
    expect(lerRespostaDoEndereco('{"endereco": "Rua das Flores, 100, Vitória, ES"}')).toBe(
      "Rua das Flores, 100, Vitória, ES",
    );
    expect(lerRespostaDoEndereco('{"endereco": null}')).toBeNull();
    expect(lerRespostaDoEndereco("não sei")).toBeNull();
  });

  it("compara endereço sem acento, caixa e pontuação", () => {
    expect(enderecoComparavel("Rua São João, 10")).toBe(enderecoComparavel("rua sao joao 10"));
  });
});

describe("regra do dono e conversa da equipe", () => {
  it("vazio preenche, igual nada, diferente propõe", () => {
    expect(decidir(null, false)).toBe("preencher");
    expect(decidir("  ", false)).toBe("preencher");
    expect(decidir("x", true)).toBe("nada");
    expect(decidir("x", false)).toBe("propor");
  });

  it("silêncio infinito, pessoa atribuída ou force_human são da equipe; IA ativa não", () => {
    expect(conversaDaEquipe({ bot_silenced_until: "infinity", assignee_kind: null }, {}, AGORA)).toBe(true);
    expect(conversaDaEquipe({ bot_silenced_until: null, assignee_kind: "user" }, {}, AGORA)).toBe(true);
    expect(conversaDaEquipe({ bot_silenced_until: null, assignee_kind: null }, { force_human: true }, AGORA)).toBe(true);
    expect(conversaDaEquipe({ bot_silenced_until: null, assignee_kind: "ai" }, {}, AGORA)).toBe(false);
  });
});

// ===========================================================================
// Orquestrador
// ===========================================================================

interface Escrita {
  tabela: string;
  op: "insert" | "update" | "rpc";
  valores: Record<string, unknown>;
  filtros: Array<[string, string, unknown]>;
}

interface Estado {
  ligada: boolean;
  mensagem: Record<string, unknown> | null;
  anterior: Record<string, unknown> | null;
  conversa: Record<string, unknown> | null;
  rastro: unknown[];
  avisoAberto: unknown[];
  /** O que o UPDATE de contacts devolve (linhas casadas). */
  linhasDoUpdate: number;
}

let escritas: Escrita[] = [];
/** Índice fictício que NÃO contém o número (como o HMAC de verdade). */
const indice = (cpf: string) => `idx-${[...cpf].reverse().join("")}`;
let dubleAtual: SupabaseClient;

function duble(e: Estado): SupabaseClient {
  const consulta = (tabela: string) => {
    const filtros: Array<[string, string, unknown]> = [];
    let op: Escrita["op"] | "select" = "select";
    let valores: Record<string, unknown> = {};
    const resultado = (): { data: unknown; error: null } => {
      if (op !== "select") {
        escritas.push({ tabela, op, valores, filtros: [...filtros] });
        if (tabela === "contacts") return { data: Array.from({ length: e.linhasDoUpdate }, () => ({ id: "c" })), error: null };
        if (tabela === "contact_field_proposals") return { data: { id: "prop-1" }, error: null };
        return { data: null, error: null };
      }
      if (tabela === "organizations") return { data: { settings: { crm: { extracao_silenciosa: e.ligada } } }, error: null };
      if (tabela === "messages") {
        const outbound = filtros.some(([, , v]) => v === "outbound");
        return { data: outbound ? e.anterior : e.mensagem, error: null };
      }
      if (tabela === "conversations") return { data: e.conversa, error: null };
      if (tabela === "api_audit_log") return { data: e.rastro, error: null };
      if (tabela === "agent_inbox_items") return { data: e.avisoAberto, error: null };
      if (tabela === "crm_leads") return { data: [], error: null };
      if (tabela === "contacts") return { data: e.conversa?.contacts ?? null, error: null };
      return { data: null, error: null };
    };
    const q: Record<string, unknown> = {};
    const encadeia = (nome: string) => (...args: unknown[]) => {
      filtros.push([nome, String(args[0]), args[1]]);
      return q;
    };
    for (const f of ["eq", "is", "in", "lt", "order", "limit", "filter"]) q[f] = encadeia(f);
    q.select = () => q;
    q.insert = (v: Record<string, unknown>) => {
      op = "insert";
      valores = v;
      return q;
    };
    q.update = (v: Record<string, unknown>) => {
      op = "update";
      valores = v;
      return q;
    };
    q.maybeSingle = async () => resultado();
    q.single = async () => resultado();
    q.then = (ok: (r: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(resultado()).then(ok, ko);
    return q;
  };
  return {
    from: consulta,
    rpc: async (nome: string, args: Record<string, unknown>) => {
      escritas.push({ tabela: nome, op: "rpc", valores: args, filtros: [] });
      if (nome === "cpf_indice") return { data: indice(String(args.p_plaintext)), error: null };
      if (nome === "encrypt_cpf") return { data: "\\xcafe", error: null };
      return { data: null, error: null };
    },
  } as unknown as SupabaseClient;
}

function contato(extra: Record<string, unknown> = {}) {
  return {
    id: "contato-1",
    is_blocked: false,
    is_anonymized: false,
    is_merged_into: null,
    force_human: false,
    email: null,
    birthdate: null,
    cpf_hash: null,
    custom_fields: {},
    consent: null,
    ...extra,
  };
}

function estado(p: Partial<Estado> & { contatoExtra?: Record<string, unknown>; texto?: string; conversaExtra?: Record<string, unknown> } = {}): Estado {
  return {
    ligada: p.ligada ?? true,
    mensagem: p.mensagem ?? {
      id: "msg-1",
      body: p.texto ?? `meu cpf é 529.982.247-25 e o email paciente.ficticia@exemplo.com`,
      direction: "inbound",
      conversation_id: "conv-1",
      created_at: AGORA.toISOString(),
    },
    anterior: p.anterior ?? { body: "Pode me mandar seus dados?" },
    conversa: p.conversa ?? {
      id: "conv-1",
      contact_id: "contato-1",
      is_group: false,
      bot_silenced_until: "infinity",
      assignee_kind: null,
      contacts: contato(p.contatoExtra),
      ...p.conversaExtra,
    },
    rastro: p.rastro ?? [],
    avisoAberto: p.avisoAberto ?? [],
    linhasDoUpdate: p.linhasDoUpdate ?? 1,
  };
}

async function rodar(e: Estado, lerEndereco = vi.fn(async () => null as string | null)) {
  dubleAtual = duble(e);
  const r = await extrairCadastroSilencioso(dubleAtual, { organizationId: "org-1", messageId: "msg-1" }, { agora: AGORA, lerEndereco });
  return { r, lerEndereco };
}

const enviouMensagem = () =>
  escritas.some((w) => w.tabela === "messages" || (w.op === "rpc" && w.tabela === "emit_event"));
const mexeuNoSilencio = () =>
  escritas.some((w) => w.tabela === "conversations" || "bot_silenced_until" in w.valores);

beforeEach(() => {
  escritas = [];
  auditorias.length = 0;
});

describe("o que fica de fora", () => {
  it.each([
    ["interruptor desligado", estado({ ligada: false }), "desligada"],
    ["grupo", estado({ conversaExtra: { is_group: true } }), "grupo"],
    ["contato bloqueado", estado({ contatoExtra: { is_blocked: true } }), "contato_bloqueado"],
    ["contato anonimizado", estado({ contatoExtra: { is_anonymized: true } }), "contato_anonimizado"],
    ["IA atendendo", estado({ conversaExtra: { bot_silenced_until: null, assignee_kind: "ai" } }), "conversa_com_ia"],
    ["mensagem já lida", estado({ rastro: [{ id: "a" }] }), "ja_lida"],
  ])("%s → nada é escrito", async (_nome, e, motivo) => {
    const { r, lerEndereco } = await rodar(e);
    expect(r).toEqual({ status: "ignorado", motivo });
    expect(escritas).toEqual([]);
    expect(auditorias).toEqual([]);
    expect(lerEndereco).not.toHaveBeenCalled();
  });
});

describe("ficha vazia é preenchida, com trilha e sem resposta", () => {
  it("grava CPF (par cifrado) e e-mail com a trava 'ainda vazio' no UPDATE", async () => {
    const { r } = await rodar(estado());
    expect(r).toEqual({ status: "lido", preenchidos: ["cpf", "email"], propostos: [] });

    const updates = escritas.filter((w) => w.tabela === "contacts" && w.op === "update");
    expect(updates).toHaveLength(2);
    expect(updates[0]!.valores).toMatchObject({ cpf_hash: indice(CPF_A), cpf_encrypted: "\\xcafe" });
    expect(updates[0]!.filtros).toContainEqual(["is", "cpf_hash", null]);
    expect(updates[1]!.valores).toMatchObject({ email: "paciente.ficticia@exemplo.com" });
    expect(updates[1]!.filtros).toContainEqual(["is", "email", null]);
    // CPF nunca em claro numa escrita de tabela.
    expect(JSON.stringify(updates)).not.toContain(CPF_A);

    expect(auditorias.map((a) => a.action)).toEqual(["contact.field_auto_applied", "contact.field_auto_applied"]);
    for (const a of auditorias) {
      expect(a.metadata).toMatchObject({ origem: "extracao_silenciosa", message_id: "msg-1" });
      expect(JSON.stringify(a.metadata)).not.toMatch(/52998224725|exemplo\.com/);
    }
    expect(enviouMensagem()).toBe(false);
    expect(mexeuNoSilencio()).toBe(false);
  });

  it("corrida perdida (0 linhas) não audita nem diz que gravou", async () => {
    const { r } = await rodar(estado({ linhasDoUpdate: 0 }));
    expect(r).toEqual({ status: "lido", preenchidos: [], propostos: [] });
    expect(auditorias).toEqual([]);
  });

  it("endereço só passa pelo modelo com indício, e preenche custom_fields.endereco mesclado", async () => {
    const leitor = vi.fn(async () => "Rua das Flores, 100, Vitória, ES" as string | null);
    const { r } = await rodar(
      estado({ texto: "moro na Rua das Flores, 100, Vitória", contatoExtra: { custom_fields: { convenio: "x" } } }),
      leitor,
    );
    expect(leitor).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ status: "lido", preenchidos: ["endereco"], propostos: [] });
    const u = escritas.find((w) => w.tabela === "contacts" && w.op === "update")!;
    expect(u.valores.custom_fields).toEqual({ convenio: "x", endereco: "Rua das Flores, 100, Vitória, ES" });
    expect(u.filtros).toContainEqual(["is", "custom_fields->>endereco", null]);
  });

  it("mensagem sem indício de endereço não chama o modelo", async () => {
    const { lerEndereco } = await rodar(estado({ texto: "ok, obrigada" }));
    expect(lerEndereco).not.toHaveBeenCalled();
  });
});

describe("valor diferente vira proposta + aviso; igual não faz nada", () => {
  it("e-mail diferente: proposta e aviso, a ficha não é tocada", async () => {
    const { r } = await rodar(
      estado({ texto: "email novo: outro.ficticio@exemplo.com", contatoExtra: { email: "antigo@exemplo.com" } }),
    );
    expect(r).toEqual({ status: "lido", preenchidos: [], propostos: ["email"] });
    expect(escritas.some((w) => w.tabela === "contacts" && w.op === "update")).toBe(false);
    const prop = escritas.find((w) => w.tabela === "contact_field_proposals")!;
    expect(prop.valores).toMatchObject({ campo: "email", message_id: "msg-1", valor_anterior: "antigo@exemplo.com" });
    const aviso = escritas.find((w) => w.tabela === "agent_inbox_items")!;
    expect(aviso.valores).toMatchObject({ kind: "contact_data_divergent", ref_kind: "contact", ref_id: "contato-1" });
    expect(String(aviso.valores.body)).not.toContain("exemplo.com");
    expect(auditorias.map((a) => a.action)).toEqual(["contact.field_proposed"]);
  });

  it("CPF diferente: proposta só mascarada e cifrada", async () => {
    await rodar(estado({ texto: "cpf 111.444.777-35", contatoExtra: { cpf_hash: indice(CPF_A) } }));
    const prop = escritas.find((w) => w.tabela === "contact_field_proposals")!;
    expect(prop.valores).toMatchObject({ campo: "cpf", valor_proposto: "•••.•••.•••-35", valor_anterior: null, valor_cifrado: "\\xcafe" });
    expect(JSON.stringify(prop.valores)).not.toContain(CPF_B);
  });

  it("aviso já aberto para o contato não é duplicado", async () => {
    await rodar(
      estado({ texto: "outro.ficticio@exemplo.com", contatoExtra: { email: "antigo@exemplo.com" }, avisoAberto: [{ id: "x" }] }),
    );
    expect(escritas.filter((w) => w.tabela === "agent_inbox_items")).toEqual([]);
  });

  it("valor igual ao gravado não escreve nada (é o que torna a releitura inofensiva)", async () => {
    const { r } = await rodar(
      estado({ contatoExtra: { email: "paciente.ficticia@exemplo.com", cpf_hash: indice(CPF_A) } }),
    );
    expect(r).toEqual({ status: "lido", preenchidos: [], propostos: [] });
    expect(escritas.filter((w) => w.op !== "rpc")).toEqual([]);
    expect(auditorias).toEqual([]);
  });
});

describe("o interruptor nasce desligado", () => {
  it("só o booleano true liga; ausente, torto ou string lê como desligado", async () => {
    const { extracaoSilenciosaLigada } = await import("@/lib/schemas/settings");
    expect(extracaoSilenciosaLigada({})).toBe(false);
    expect(extracaoSilenciosaLigada(null)).toBe(false);
    expect(extracaoSilenciosaLigada({ crm: { extracao_silenciosa: "true" } })).toBe(false);
    expect(extracaoSilenciosaLigada({ crm: { extracao_silenciosa: true } })).toBe(true);
  });

  it("o consumidor está registrado em message.received, ao lado do worker de resposta", async () => {
    const { ensureHandlersRegistered } = await import("@/lib/event-log/register-handlers");
    const { getRegisteredHandlers } = await import("@/lib/event-log/dispatcher");
    ensureHandlersRegistered();
    const chaves = getRegisteredHandlers()
      .filter((h) => h.events.includes("message.received"))
      .map((h) => h.key);
    expect(chaves).toContain("extracao-silenciosa.v1");
    expect(chaves).toContain("ai-response-worker.v1");
  });
});
