import { beforeEach, expect, it, vi } from "vitest";
import type { RegraDeComentario } from "@/lib/comentarios/regra";
import type { PerfilDeVoz } from "@/lib/comentarios/voz";

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
};

let fake: Fake;
let linhas: Record<string, { situacao: string; motivo_do_toque: string | null; sugestao_de_resposta: string | null; resposta_publica_id?: string | null }>;
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
    async marcarEsperando(id: string, motivo: string, sugestao: string | null) {
      linhas[id] = { situacao: "esperando_voce", motivo_do_toque: motivo, sugestao_de_resposta: sugestao };
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
  fake.comentarios = [{ ...comentario, texto: "quanto custa?" }];
  await processarComentariosNovos(fake, agora);
  expect(linha().situacao).toBe("esperando_voce");
  expect(linha().motivo_do_toque).toBe("preço");
  expect(fake.publicacoes).toHaveLength(0);
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
  const chamadas: { tabela: string; eqs: [string, unknown][] }[] = [];
  function chain(tabela: string) {
    const eqs: [string, unknown][] = [];
    chamadas.push({ tabela, eqs });
    const obj: Record<string, (...a: unknown[]) => unknown> = {};
    obj.select = () => obj;
    obj.eq = (col: unknown, val: unknown) => {
      eqs.push([String(col), val]);
      return obj;
    };
    obj.not = () => obj;
    obj.order = () => obj;
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
