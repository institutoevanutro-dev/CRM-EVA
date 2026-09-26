import { beforeEach, expect, it, vi } from "vitest";
import type { RegraDeComentario } from "@/lib/comentarios/regra";
import type { PerfilDeVoz } from "@/lib/comentarios/voz";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
const loggerErrorMock = vi.fn();
vi.mock("@/lib/logger", () => ({
  logger: { error: (...a: unknown[]) => loggerErrorMock(...a), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { processarComentariosNovos, avisarComentariosParados } = await import("@/workers/comentarios-worker");

type ComentarioFake = {
  id: string;
  organizationId: string;
  channelSessionId: string | null;
  externalId: string;
  mediaId: string;
  autorIgsid: string;
  comentadoEm: string;
  texto: string | null;
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
};

let fake: Fake;
let linhas: Record<string, { situacao: string; motivo_do_toque: string | null; sugestao_de_resposta: string | null; resposta_publica_id?: string | null }>;
function linha(id = comentario.id) {
  return linhas[id]!;
}

beforeEach(() => {
  linhas = {};
  loggerErrorMock.mockClear();
  fake = {
    comentarios: [],
    regras: [],
    acoesAplicadas: [],
    publicacoes: [],
    erroDaIa: undefined,
    textoGerado: "Que bom que gostou! 🌿",
    perfil: perfilPadrao,
    reivindicarDevolve: true,

    async comentariosNovos(teto: number) {
      return fake.comentarios.slice(0, teto);
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
      linhas[id] = {
        situacao: patch.situacao,
        motivo_do_toque: patch.motivo_do_toque,
        sugestao_de_resposta: null,
        resposta_publica_id: patch.resposta_publica_id,
      };
    },
    async respostasAnterioresDoDono() {
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

it("resposta que chama o dono de nutrólogo é recusada, não publicada", async () => {
  fake.comentarios = [{ ...comentario, texto: "top!" }];
  fake.textoGerado = "Obrigado! O nutrólogo agradece 🌿";
  await processarComentariosNovos(fake, agora);
  expect(linha().situacao).toBe("esperando_voce");
  expect(fake.publicacoes).toHaveLength(0);
  // a sugestão fica registrada, para um humano ver o que quase saiu
  expect(linha().sugestao_de_resposta).toBe("Obrigado! O nutrólogo agradece 🌿");
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

// ---- aviso anti-morte ----

type ParadoFake = Parameters<typeof avisarComentariosParados>[0] & {
  parados: { id: string; organizationId: string }[];
  avisosAbertos: string[];
  jaAvisadosPara: Set<string>;
};

it("aviso anti-morte abre para comentário parado há mais de 1h, e não duplica se já aberto", async () => {
  const f: ParadoFake = {
    parados: [
      { id: "P-1", organizationId: "org" },
      { id: "P-2", organizationId: "org" },
    ],
    avisosAbertos: [],
    jaAvisadosPara: new Set(["P-2"]),
    async comentariosParados() {
      return f.parados;
    },
    async jaAvisado(id: string) {
      return f.jaAvisadosPara.has(id);
    },
    async abrirAviso(c) {
      f.avisosAbertos.push(c.id);
    },
  };
  const r = await avisarComentariosParados(f, agora);
  expect(r.avisados).toBe(1);
  expect(f.avisosAbertos).toEqual(["P-1"]);
});
