import { beforeEach, expect, it, vi } from "vitest";
import type { RegraDeComentario } from "@/lib/comentarios/regra";
import type { PerfilDeVoz } from "@/lib/comentarios/voz";
import { FRASES_PADRAO } from "@/lib/comentarios/gatilho-direct";

const auditMock = vi.fn(async (_arg: unknown) => undefined);
vi.mock("@/lib/audit", () => ({ audit: (arg: unknown) => auditMock(arg) }));
const loggerErrorMock = vi.fn();
const loggerWarnMock = vi.fn();
vi.mock("@/lib/logger", () => ({
  logger: {
    error: (...a: unknown[]) => loggerErrorMock(...a),
    warn: (...a: unknown[]) => loggerWarnMock(...a),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─── I-10: o seam medido/orçado, mockado para o teste de wiring real ───────
const llmMocks = vi.hoisted(() => ({
  runModelCall: vi.fn(async () => ({ result: { text: "  Que bom que gostou! 🌿  " } } as never)),
}));
vi.mock("@/lib/agent-engine/edge/llm/run-model-call", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent-engine/edge/llm/run-model-call")>();
  return { ...actual, runModelCall: llmMocks.runModelCall };
});
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => "POOL_FAKE" }));

const {
  processarComentariosNovos,
  avisarComentariosParados,
  construirAdminDoWorkerReal,
  construirAdminDoAvisoAntiMorteReal,
} = await import("@/workers/comentarios-worker");

type ComentarioFake = {
  id: string;
  organizationId: string;
  channelSessionId: string | null;
  externalId: string;
  mediaId: string;
  autorIgsid: string;
  comentadoEm: string;
  texto: string | null;
  reivindicadoEm: string | null;
};

const comentario: ComentarioFake = {
  id: "IC-1",
  organizationId: "org",
  channelSessionId: "session-1",
  externalId: "C-1",
  mediaId: "MEDIA-1",
  autorIgsid: "IGSID-1",
  comentadoEm: "2026-09-26T12:00:00Z",
  texto: "top!",
  reivindicadoEm: null,
};

const agora = new Date("2026-09-26T13:00:00Z");

const perfilPadrao: PerfilDeVoz = { frases: ["Que bom que gostou! 🌿"], emojis: ["🌿"], tratamento: "você" };

type Fake = Parameters<typeof processarComentariosNovos>[0] & {
  comentarios: ComentarioFake[];
  regras: RegraDeComentario[];
  acoesAplicadas: unknown[];
  publicacoes: unknown[];
  erroDaIa?: Error;
  textoGerado: string;
  perfil: PerfilDeVoz | null;
  reivindicarDevolve: boolean;
  chamadasDeVoz: number;
  gravarDesfechoFalha?: boolean;
  frases: { preco: string; agendamento: string };
  aprovadas: Set<string>;
};

let fake: Fake;
let linhas: Record<string, { situacao: string; motivo_do_toque: string | null; sugestao_de_resposta: string | null; resposta_publica_id?: string | null; private_reply_message_id?: string | null }>;
function linha(id = comentario.id) {
  return linhas[id]!;
}

beforeEach(() => {
  linhas = {};
  loggerErrorMock.mockClear();
  loggerWarnMock.mockClear();
  auditMock.mockClear();
  llmMocks.runModelCall.mockClear();
  fake = {
    comentarios: [],
    regras: [],
    acoesAplicadas: [],
    publicacoes: [],
    erroDaIa: undefined,
    textoGerado: "Que bom que gostou! 🌿",
    perfil: perfilPadrao,
    reivindicarDevolve: true,
    chamadasDeVoz: 0,
    gravarDesfechoFalha: false,
    frases: { ...FRASES_PADRAO },
    aprovadas: new Set<string>(),

    // I-6: a fila é por organização — o fake espelha a query real (filtro por
    // organization_id + teto), não uma lista global.
    async organizacoesComComentariosNovos() {
      return [...new Set(fake.comentarios.map((c) => c.organizationId))];
    },
    async comentariosNovos(organizationId: string, teto: number) {
      return fake.comentarios.filter((c) => c.organizationId === organizationId).slice(0, teto);
    },
    async regrasDaMidia() {
      return fake.regras;
    },
    async reivindicar() {
      return fake.reivindicarDevolve;
    },
    async jaMandouPrivado() {
      return false;
    },
    async enviarPrivada() {
      return { messageId: "MID-1" };
    },
    async enviarPublica() {
      // `aplicarRegra` chama isto exatamente uma vez por comentário com regra
      // (tem seu próprio try/catch e não é reentrado) — ao contrário de
      // `gravarDesfecho`, que pode rodar duas vezes (checkpoint da privada +
      // gravação final). É por isso que "ações aplicadas" conta aqui, não lá.
      fake.acoesAplicadas.push({});
      return { replyId: "REPLY-1" };
    },
    async gravarDesfecho(id: string, patch) {
      if (fake.gravarDesfechoFalha) throw new Error("erro de banco simulado");
      linhas[id] = {
        situacao: patch.situacao,
        motivo_do_toque: patch.motivo_do_toque,
        sugestao_de_resposta: null,
        resposta_publica_id: patch.resposta_publica_id,
      };
    },
    async respostasAnterioresDoDono() {
      fake.chamadasDeVoz++;
      return fake.perfil ? fake.perfil.frases : [];
    },
    async gerarResposta() {
      if (fake.erroDaIa) throw fake.erroDaIa;
      return fake.textoGerado;
    },
    async publicarResposta(c, texto: string) {
      fake.publicacoes.push({ id: c.id, texto });
      return { replyId: "PUB-1" };
    },
    async marcarEsperando(id: string, motivo: string, sugestao: string | null, privadaId?: string | null) {
      linhas[id] = {
        situacao: "esperando_voce",
        motivo_do_toque: motivo,
        sugestao_de_resposta: sugestao,
        // Espelha o admin real: a coluna só entra na gravação quando veio um
        // valor — escrever `null` aqui apagaria o rastro de uma privada que
        // JÁ saiu (o caso do lease vencido).
        ...(privadaId === undefined ? {} : { private_reply_message_id: privadaId }),
      };
    },
    async frasesDeGatilho() {
      return fake.frases;
    },
    async palavrasAprovadas() {
      return fake.aprovadas;
    },
    async marcarRespondidoPelaIa(id: string, texto: string, replyId: string | null) {
      linhas[id] = {
        situacao: "respondido_pela_ia",
        motivo_do_toque: null,
        sugestao_de_resposta: texto,
        resposta_publica_id: replyId,
      };
    },
  };
});

it("comentário que casa regra vai para a ação", async () => {
  fake.comentarios = [comentario];
  fake.regras = [
    { id: "regra-1", mediaId: "MEDIA-1", palavra: "top", textoDoDirect: "direct", frasePublica: "publica", criadaEm: "2026-09-01T00:00:00Z" },
  ];
  const r = await processarComentariosNovos(fake, agora);
  expect(r.atendidos).toBe(1);
  expect(r.esperando).toBe(0);
  expect(fake.acoesAplicadas).toHaveLength(1);
});

it("comentário seguro sem regra: a IA escreve e publica", async () => {
  fake.comentarios = [{ ...comentario, texto: "amei 😍" }];
  await processarComentariosNovos(fake, agora);
  expect(linha().situacao).toBe("respondido_pela_ia");
  expect(fake.publicacoes).toHaveLength(1);
});

it("comentário inseguro sem regra: NADA é publicado, fica esperando", async () => {
  // "medicação" e não "preço": desde a abertura de conversa por gatilho, o
  // motivo de preço carrega TAMBÉM o que aconteceu com a mensagem privada.
  // Aqui o que se mede é a régua de publicação, então o gatilho usado é um
  // que não manda nada e o motivo continua sendo só o rótulo.
  fake.comentarios = [{ ...comentario, texto: "posso tomar mounjaro?" }];
  await processarComentariosNovos(fake, agora);
  expect(linha().situacao).toBe("esperando_voce");
  expect(linha().motivo_do_toque).toBe("medicação");
  expect(fake.publicacoes).toHaveLength(0);
});

// ─── IMPORTANTE 6 — §9 promete comment.waiting_human sempre que cai pra fila humana ─
it("IMPORTANTE 6 — todo caminho que manda pra esperando_voce audita comment.waiting_human", async () => {
  fake.comentarios = [{ ...comentario, texto: "quanto custa?" }];
  await processarComentariosNovos(fake, agora);
  expect(auditMock).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "comment.waiting_human",
      organizationId: comentario.organizationId,
      resourceType: "instagram_comment",
      resourceId: comentario.id,
      metadata: expect.objectContaining({ motivo: expect.stringContaining("preço") }),
    }),
  );
});

it("IMPORTANTE 6 — regra que cai pra esperando_voce (janela de 7 dias vencida) também audita", async () => {
  fake.comentarios = [{ ...comentario, comentadoEm: "2000-01-01T00:00:00Z" }];
  fake.regras = [
    { id: "regra-1", mediaId: "MEDIA-1", palavra: "top", textoDoDirect: "d", frasePublica: "p", criadaEm: "2026-09-01T00:00:00Z" },
  ];
  await processarComentariosNovos(fake, agora);
  expect(linha().situacao).toBe("esperando_voce");
  expect(auditMock).toHaveBeenCalledWith(
    expect.objectContaining({ action: "comment.waiting_human", resourceId: comentario.id }),
  );
});

it("a IA falhou: fica esperando, sem publicar vazio", async () => {
  fake.erroDaIa = new Error("modelo fora do ar");
  fake.comentarios = [{ ...comentario, texto: "top!" }];
  await processarComentariosNovos(fake, agora);
  expect(linha().situacao).toBe("esperando_voce");
  expect(fake.publicacoes).toHaveLength(0);
});

// ─── C-1: a trava de CFM só pegava a palavra EXATA — plural/derivada furava ─
it.each([
  "Obrigado! Os nutrólogos agradecem",
  "Somos especialistas em nutrição",
  "Sou nutrologista, obrigado",
  "Essa é a nossa especialidade",
  "Fiz especialização nisso",
])("C-1 — resposta '%s' é recusada (radical, não palavra exata)", async (textoGerado) => {
  fake.comentarios = [{ ...comentario, texto: "top!" }];
  fake.textoGerado = textoGerado;
  await processarComentariosNovos(fake, agora);
  expect(linha().situacao).toBe("esperando_voce");
  expect(fake.publicacoes).toHaveLength(0);
});

it("resposta com link ou preço também é recusada", async () => {
  fake.comentarios = [
    { ...comentario, id: "IC-2", externalId: "c2", texto: "top!" },
  ];
  fake.textoGerado = "Manda um R$ 50 que eu te mostro https://exemplo.com";
  await processarComentariosNovos(fake, agora);
  expect(linha("IC-2").situacao).toBe("esperando_voce");
  expect(fake.publicacoes).toHaveLength(0);
});

it("sem perfil de voz, a IA não publica sozinha — cai esperando_voce", async () => {
  fake.perfil = null;
  fake.comentarios = [{ ...comentario, texto: "top!" }];
  await processarComentariosNovos(fake, agora);
  expect(linha().situacao).toBe("esperando_voce");
  expect(fake.publicacoes).toHaveLength(0);
});

it("teto por rodada é respeitado", async () => {
  fake.comentarios = Array.from({ length: 80 }, (_, i) => ({
    ...comentario,
    id: `IC-${i}`,
    externalId: `c${i}`,
    texto: "top!",
  }));
  const r = await processarComentariosNovos(fake, agora, 50);
  expect(r.atendidos + r.esperando).toBe(50);
});

it("reivindicação perdida (outra rodada já pegou) não conta nem publica de novo", async () => {
  fake.reivindicarDevolve = false;
  fake.comentarios = [{ ...comentario, texto: "top!" }];
  const r = await processarComentariosNovos(fake, agora);
  expect(r.atendidos + r.esperando).toBe(0);
  expect(fake.publicacoes).toHaveLength(0);
});

// ─── C-2: a IA publica no nome do dono sem deixar auditoria por comentário ──
it("C-2 — resposta publicada pela IA audita por comentário, com o texto", async () => {
  fake.comentarios = [{ ...comentario, texto: "amei 😍" }];
  await processarComentariosNovos(fake, agora);
  expect(auditMock).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "comment.replied_by_ai",
      organizationId: comentario.organizationId,
      resourceId: comentario.id,
      metadata: expect.objectContaining({ texto: fake.textoGerado }),
    }),
  );
});

// ─── I-3: repesque de lease vencido não pode remandar rede sozinho ─────────
it("I-3 — lease AINDA vigente (outra rodada pode estar processando agora): pula em silêncio, não toca nada", async () => {
  fake.comentarios = [
    { ...comentario, texto: "top!", reivindicadoEm: new Date(agora.getTime() - 2 * 60 * 1000).toISOString() },
  ];
  const r = await processarComentariosNovos(fake, agora);
  expect(r.atendidos + r.esperando).toBe(0);
  expect(linha()).toBeUndefined();
  expect(fake.publicacoes).toHaveLength(0);
});

it("I-3 — lease VENCIDO (tentativa anterior não terminou): cai esperando_voce, NUNCA repesca sozinho", async () => {
  fake.comentarios = [
    { ...comentario, texto: "top!", reivindicadoEm: new Date(agora.getTime() - 11 * 60 * 1000).toISOString() },
  ];
  const r = await processarComentariosNovos(fake, agora);
  expect(linha().situacao).toBe("esperando_voce");
  expect(r.esperando).toBe(1);
  expect(fake.publicacoes).toHaveLength(0);
});

// ─── I-4: aplicarRegra que engole a falha de gravação não pode contar como atendida ─
it("I-4 — regra casa mas a gravação final falha: NÃO conta como atendida", async () => {
  fake.comentarios = [{ ...comentario, texto: "top!" }];
  fake.regras = [
    { id: "regra-1", mediaId: "MEDIA-1", palavra: "top", textoDoDirect: "d", frasePublica: "p", criadaEm: "2026-09-01T00:00:00Z" },
  ];
  fake.gravarDesfechoFalha = true;
  const r = await processarComentariosNovos(fake, agora);
  expect(r.atendidos).toBe(0);
  expect(r.esperando).toBe(0);
});

// ─── I-5: perfilDeVoz por comentário é uma chamada pesada à Graph ──────────
it("I-5 — respostasAnterioresDoDono é chamado no máximo uma vez por sessão por rodada (cache)", async () => {
  fake.comentarios = Array.from({ length: 5 }, (_, i) => ({
    ...comentario,
    id: `IC-${i}`,
    externalId: `c${i}`,
    texto: "top!",
  }));
  await processarComentariosNovos(fake, agora);
  expect(fake.chamadasDeVoz).toBe(1);
});

// ─── I-6: a fila é por organização, não global ─────────────────────────────
it("I-6 — um tenant com volume alto não consome o teto dos outros", async () => {
  const orgA = Array.from({ length: 80 }, (_, i) => ({
    ...comentario,
    id: `A-${i}`,
    organizationId: "orgA",
    externalId: `a${i}`,
    texto: "top!",
  }));
  const orgB = { ...comentario, id: "B-1", organizationId: "orgB", externalId: "b1", texto: "top!" };
  fake.comentarios = [...orgA, orgB];
  const r = await processarComentariosNovos(fake, agora, 50);
  // 50 (teto de orgA) + 1 (orgB, nunca starved) — se a fila fosse global,
  // orgB ficaria de fora e o total seria 50.
  expect(r.atendidos + r.esperando).toBe(51);
  expect(linha("B-1")).toBeDefined();
});

// ─── I-9: um comentário poluído não pode travar a rodada inteira ───────────
it("I-9 — um comentário que lança no meio do processamento não trava os demais", async () => {
  fake.comentarios = [
    { ...comentario, id: "IC-poison", externalId: "poison", texto: "quanto custa?" },
    { ...comentario, id: "IC-2", externalId: "c2", texto: "top!" },
  ];
  const marcarEsperandoOriginal = fake.marcarEsperando.bind(fake);
  fake.marcarEsperando = async (id: string, motivo: string, sugestao: string | null) => {
    if (id === "IC-poison") throw new Error("erro de banco simulado no comentário envenenado");
    return marcarEsperandoOriginal(id, motivo, sugestao);
  };
  const r = await processarComentariosNovos(fake, agora);
  expect(r.atendidos).toBe(1);
  expect(linha("IC-2").situacao).toBe("respondido_pela_ia");
  expect(loggerErrorMock).toHaveBeenCalled();
});

// ---- aviso anti-morte (I-7: agregado por organização, não por linha) ------

type ParadoFake = Parameters<typeof avisarComentariosParados>[0] & {
  contagem: { organizationId: string; quantidade: number }[];
  avisosAbertos: { organizationId: string; quantidade: number }[];
  jaAvisadosPara: Set<string>;
};

it("I-7 — aviso anti-morte é UM item agregado por organização, não um por comentário", async () => {
  const f: ParadoFake = {
    contagem: [
      { organizationId: "orgA", quantidade: 12 },
      { organizationId: "orgB", quantidade: 1 },
    ],
    avisosAbertos: [],
    jaAvisadosPara: new Set(["orgB"]),
    async contagemDeComentariosParados() {
      return f.contagem;
    },
    async jaAvisado(organizationId: string) {
      return f.jaAvisadosPara.has(organizationId);
    },
    async abrirAviso(organizationId: string, quantidade: number) {
      f.avisosAbertos.push({ organizationId, quantidade });
    },
  };
  const r = await avisarComentariosParados(f, agora);
  expect(r.avisados).toBe(1);
  expect(f.avisosAbertos).toEqual([{ organizationId: "orgA", quantidade: 12 }]);
});

// ---- wiring real: I-8 e I-10 ------------------------------------------------

/** Espião mínimo de um cliente supabase-like — grava toda `.eq()` por tabela. */
function criarClienteEspiao(respostas: Record<string, unknown>) {
  const chamadas: { tabela: string; eqs: [string, unknown][]; ordens: string[]; lts: [string, unknown][] }[] = [];
  function chain(tabela: string) {
    const eqs: [string, unknown][] = [];
    const ordens: string[] = [];
    const lts: [string, unknown][] = [];
    chamadas.push({ tabela, eqs, ordens, lts });
    const obj: Record<string, (...a: unknown[]) => unknown> = {};
    obj.select = () => obj;
    obj.eq = (col: unknown, val: unknown) => {
      eqs.push([String(col), val]);
      return obj;
    };
    obj.lt = (col: unknown, val: unknown) => {
      lts.push([String(col), val]);
      return obj;
    };
    obj.not = () => obj;
    obj.order = (col: unknown) => {
      ordens.push(String(col));
      return obj;
    };
    obj.limit = () => obj;
    obj.or = () => obj;
    obj.update = () => obj;
    obj.insert = async () => ({ error: null });
    obj.maybeSingle = async () => ({ data: respostas[tabela] ?? null, error: null });
    return obj;
  }
  return { client: { from: (tabela: string) => chain(tabela) }, chamadas };
}

it("I-8 — jaMandouPrivado filtra organization_id na query real (anti-pattern nº10)", async () => {
  const { client, chamadas } = criarClienteEspiao({});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminReal = construirAdminDoWorkerReal(client as any);
  await adminReal.jaMandouPrivado({ organizationId: "org-x", mediaId: "m1", autorIgsid: "a1" });
  const chamada = chamadas.find((c) => c.tabela === "instagram_comments");
  expect(chamada?.eqs).toContainEqual(["organization_id", "org-x"]);
});

it("IMPORTANTE 4 — jaMandouPrivado filtra por situacao='respondido_pela_regra', NÃO só por private_reply_message_id", async () => {
  // A Graph pode não devolver message_id mesmo com a privada enviada — filtrar
  // só por `private_reply_message_id is not null` perdia essa linha e mandava
  // um SEGUNDO Direct para a mesma pessoa (achado da revisão final).
  const { client, chamadas } = criarClienteEspiao({});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminReal = construirAdminDoWorkerReal(client as any);
  await adminReal.jaMandouPrivado({ organizationId: "org-x", mediaId: "m1", autorIgsid: "a1" });
  const chamada = chamadas.find((c) => c.tabela === "instagram_comments");
  expect(chamada?.eqs).toContainEqual(["situacao", "respondido_pela_regra"]);
  expect(chamada?.eqs.some(([col]) => col === "private_reply_message_id")).toBe(false);
});

it("MENOR — organizacoesComComentariosNovos ordena por comentado_em (não perde organização acima de 2000 linhas)", async () => {
  const { client, chamadas } = criarClienteEspiao({});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminReal = construirAdminDoWorkerReal(client as any);
  await adminReal.organizacoesComComentariosNovos();
  const chamada = chamadas.find((c) => c.tabela === "instagram_comments");
  expect(chamada?.ordens).toContainEqual("comentado_em");
});

it("MENOR — contagemDeComentariosParados conta por created_at (hora de CHEGADA), não comentado_em", async () => {
  const { client, chamadas } = criarClienteEspiao({});
  const adminReal = construirAdminDoAvisoAntiMorteReal(client as unknown as Parameters<typeof construirAdminDoAvisoAntiMorteReal>[0]);
  await adminReal.contagemDeComentariosParados("2026-09-26T00:00:00.000Z");
  const chamada = chamadas.find((c) => c.tabela === "instagram_comments");
  expect(chamada?.lts).toContainEqual(["created_at", "2026-09-26T00:00:00.000Z"]);
  expect(chamada?.lts.some(([col]) => col === "comentado_em")).toBe(false);
});

it("I-10 — gerarResposta passa pelo seam medido/orçado (runModelCall), não chama o modelo direto", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminReal = construirAdminDoWorkerReal({} as any);
  const texto = await adminReal.gerarResposta({ ...comentario, texto: "top!" }, perfilPadrao);
  expect(texto).toBe("Que bom que gostou! 🌿");
  expect(llmMocks.runModelCall).toHaveBeenCalledWith(
    "POOL_FAKE",
    expect.anything(),
    expect.objectContaining({ tenantId: comentario.organizationId, purpose: "instagram_comment_reply" }),
  );
});

// ───────────────────────────────────────────────────────────────────────────
// Abrir conversa no Direct quando a trava barra por intenção de compra.
//
// A trava recusa publicar em público e diz por quê. Dois desses motivos são
// alguém querendo comprar: quem pergunta preço e quem quer marcar. Esses
// recebem uma mensagem privada e CONTINUAM na fila — a privada começa a
// conversa, ela não substitui o dono. Os outros motivos não mandam nada.
// ───────────────────────────────────────────────────────────────────────────

const enviados: Array<{ commentId: string; texto: string }> = [];
function capturarEnvios() {
  enviados.length = 0;
  fake.enviarPrivada = async (input) => {
    enviados.push({ commentId: input.commentId, texto: input.texto });
    return { messageId: "MID-GATILHO" };
  };
}

it("preço: manda o Direct, guarda o id da mensagem e MANTÉM o comentário na fila", async () => {
  fake.comentarios = [{ ...comentario, texto: "quanto custa?" }];
  capturarEnvios();

  const r = await processarComentariosNovos(fake, agora);

  expect(enviados).toEqual([{ commentId: "C-1", texto: FRASES_PADRAO.preco }]);
  expect(r.esperando).toBe(1);
  expect(linha().situacao).toBe("esperando_voce");
  expect(linha().private_reply_message_id).toBe("MID-GATILHO");
  expect(linha().motivo_do_toque).toContain("preço");
  expect(linha().motivo_do_toque).toContain("mensagem privada");
});

it("preço NUNCA vira resposta pública, nem com o Direct enviado", async () => {
  fake.comentarios = [{ ...comentario, texto: "quanto custa?" }];
  capturarEnvios();

  await processarComentariosNovos(fake, agora);

  expect(fake.publicacoes).toEqual([]);
  expect(fake.acoesAplicadas).toEqual([]);
});

it("agendamento também abre conversa, com a frase dele", async () => {
  fake.comentarios = [{ ...comentario, texto: "como faço para marcar?" }];
  capturarEnvios();

  await processarComentariosNovos(fake, agora);

  expect(enviados).toEqual([{ commentId: "C-1", texto: FRASES_PADRAO.agendamento }]);
});

it("sintoma NÃO manda Direct: assunto clínico não abre conversa sozinho", async () => {
  fake.comentarios = [{ ...comentario, texto: "sinto muita tontura, é normal isso?" }];
  capturarEnvios();

  const r = await processarComentariosNovos(fake, agora);

  expect(enviados).toEqual([]);
  expect(r.esperando).toBe(1);
  expect(linha().private_reply_message_id).toBeUndefined();
});

it("medicação e especialidade também não mandam nada", async () => {
  for (const texto of ["posso tomar mounjaro?", "você é nutrólogo?"]) {
    fake.comentarios = [{ ...comentario, texto }];
    capturarEnvios();
    await processarComentariosNovos(fake, agora);
    expect(enviados, texto).toEqual([]);
  }
});

it("a frase do dono vence a padrão", async () => {
  fake.comentarios = [{ ...comentario, texto: "qual o valor?" }];
  fake.frases = { ...FRASES_PADRAO, preco: "Oi! Me conta: qual seu maior objetivo hoje?" };
  capturarEnvios();

  await processarComentariosNovos(fake, agora);

  expect(enviados[0]!.texto).toBe("Oi! Me conta: qual seu maior objetivo hoje?");
});

it("quem já recebeu privada deste vídeo não recebe outra, e o motivo diz isso", async () => {
  fake.comentarios = [{ ...comentario, texto: "quanto custa?" }];
  capturarEnvios();
  fake.jaMandouPrivado = async () => true;

  await processarComentariosNovos(fake, agora);

  expect(enviados).toEqual([]);
  expect(linha().motivo_do_toque).toContain("já recebeu");
  expect(linha().private_reply_message_id).toBeUndefined();
});

it("passados os 7 dias, não manda e o motivo explica", async () => {
  fake.comentarios = [{ ...comentario, texto: "quanto custa?", comentadoEm: "2026-09-01T12:00:00Z" }];
  capturarEnvios();

  await processarComentariosNovos(fake, agora);

  expect(enviados).toEqual([]);
  expect(linha().motivo_do_toque).toContain("7 dias");
});

it("Meta recusando: o motivo carrega o erro e NADA finge que a mensagem saiu", async () => {
  fake.comentarios = [{ ...comentario, texto: "quanto custa?" }];
  fake.enviarPrivada = async () => {
    throw new Error("(#10) Application does not have permission");
  };

  const r = await processarComentariosNovos(fake, agora);

  expect(r.esperando).toBe(1);
  expect(linha().motivo_do_toque).toContain("preço");
  expect(linha().motivo_do_toque).toContain("does not have permission");
  expect(linha().private_reply_message_id).toBeUndefined();
});

it("regra de palavra continua vencendo o gatilho: quem tem regra não passa por aqui", async () => {
  fake.comentarios = [{ ...comentario, texto: "quanto custa o cardápio?" }];
  fake.regras = [
    { id: "regra-1", mediaId: "MEDIA-1", palavra: "cardápio", textoDoDirect: "o link", frasePublica: "te mandei", criadaEm: "2026-09-01T00:00:00Z" },
  ];
  capturarEnvios();

  const r = await processarComentariosNovos(fake, agora);

  expect(r.atendidos).toBe(1);
  expect(enviados).toEqual([{ commentId: "C-1", texto: "o link" }]);
});

it("palavra aprovada pela organização faz a IA responder sozinha", async () => {
  fake.comentarios = [{ ...comentario, texto: "conteudo fantastico" }];
  fake.aprovadas = new Set(["fantastico"]);

  const r = await processarComentariosNovos(fake, agora);

  expect(r.atendidos).toBe(1);
  expect(fake.publicacoes).toHaveLength(1);
});

it("sem a palavra aprovada, o mesmo comentário continua esperando você", async () => {
  fake.comentarios = [{ ...comentario, texto: "conteudo fantastico" }];

  const r = await processarComentariosNovos(fake, agora);

  expect(r.esperando).toBe(1);
  expect(fake.publicacoes).toEqual([]);
});

// Review Focus 3: o conjunto é POR organização.
it("lê as aprovadas uma vez por organização, não uma por comentário", async () => {
  const pedidos: string[] = [];
  fake.palavrasAprovadas = async (org: string) => {
    pedidos.push(org);
    return new Set(["fantastico"]);
  };
  fake.comentarios = [
    { ...comentario, id: "IC-1", texto: "conteudo fantastico" },
    { ...comentario, id: "IC-2", externalId: "C-2", texto: "video fantastico" },
  ];

  await processarComentariosNovos(fake, agora);

  expect(pedidos).toEqual(["org"]);
});

it("preço com leitura falha ainda manda o Direct: o sufixo não pode matar o gatilho", async () => {
  fake.comentarios = [{ ...comentario, texto: "quanto custa?" }];
  fake.palavrasAprovadas = async () => {
    throw new Error("banco fora do ar");
  };
  const enviados: string[] = [];
  fake.enviarPrivada = async (i) => {
    enviados.push(i.commentId);
    return { messageId: "MID-1" };
  };

  await processarComentariosNovos(fake, agora);

  expect(enviados).toEqual(["C-1"]);
});

it("leitura das aprovadas que falha não publica nada, e diz o motivo", async () => {
  fake.comentarios = [{ ...comentario, texto: "conteudo fantastico" }];
  fake.palavrasAprovadas = async () => {
    throw new Error("banco fora do ar");
  };

  const r = await processarComentariosNovos(fake, agora);

  expect(r.esperando).toBe(1);
  expect(fake.publicacoes).toEqual([]);
  expect(linha().motivo_do_toque).toContain("palavras liberadas");
});
