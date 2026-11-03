import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/v1/contacts/duplicates — a leitura que alimenta a tela Duplicados.
 *
 * Identidades de Instagram: com até 2000 contatos varridos, um
 * `.in("contact_id", [...2000 UUIDs])` vira uma URL de ~75 KB no GET do
 * PostgREST: estoura, o erro era ignorado e os pares Instagram × WhatsApp
 * sumiam da tela em silêncio. A leitura agora é só por org + canal, a
 * interseção é em memória, e erro vira 500 visível.
 *
 * Varredura (#2561): o PostgREST corta TODA resposta no `max_rows` (1000) sem
 * erro. O dublê impõe esse corte, respeita `range` e devolve `count` só quando
 * pedido — um dublê que devolvesse a lista inteira passaria nos dois mundos e
 * não mediria nada, e o laço paginado releria a mesma lista até o teto.
 *
 * Nome parecido (porte do #3640): só para gestor, depois dos fortes, sem os
 * pares dispensados; a leitura das dispensas e a trilha `contact.listed` são
 * mockadas aqui (quem prova a dispensa no banco é tests/invariants/).
 */
import { auditarLeitura } from "@/lib/audit/leitura";
import { parDeContatos } from "@/lib/contacts/duplicados";

const sessao = vi.hoisted(() => ({ papel: "viewer" }));
const dispensa = vi.hoisted(() => ({ pares: new Set<string>(), erro: false, leituras: 0 }));

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "U1", idioma: "pt" }),
  resolveActiveOrg: async () => ({ orgId: "ORG", name: "Org", role: sessao.papel }),
}));
vi.mock("@/lib/contacts/dispensar-par", () => ({
  lerParesDispensados: async () => {
    dispensa.leituras += 1;
    if (dispensa.erro) throw new Error("permission denied for table merge_queue");
    return new Set(dispensa.pares);
  },
}));
vi.mock("@/lib/audit/leitura", () => ({ auditarLeitura: vi.fn() }));

type Linha = Record<string, unknown>;
type Chamada = { tabela: string; metodo: string; args: unknown[] };
let chamadas: Chamada[] = [];
let erroIdentidades: { message: string } | null = null;
/** O `max_rows` do servidor: o corte é dele, não do `.limit()`. */
let maxRows = 1000;

const PAR_INSTAGRAM_WHATSAPP: Linha[] = [
  { id: "insta", name: null, display_name: "José Souza", email: null, email_normalized: null, phone_number: null,
    is_merged_into: null, is_anonymized: false, source_metadata: null, created_at: "2026-01-01T00:00:00Z", last_activity_at: null },
  { id: "zap", name: "Jose Souza", display_name: null, email: null, email_normalized: null, phone_number: "+5531998966398",
    is_merged_into: null, is_anonymized: false, source_metadata: null, created_at: "2026-01-02T00:00:00Z", last_activity_at: null },
];
let contatos: Linha[] = PAR_INSTAGRAM_WHATSAPP;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabela: string) => {
      const c: Record<string, unknown> = {};
      let faixa: [number, number] | null = null;
      let limite: number | null = null;
      let pediuCount = false;
      for (const metodo of ["select", "eq", "is", "in", "order", "limit", "range"]) {
        c[metodo] = (...args: unknown[]) => {
          chamadas.push({ tabela, metodo, args });
          if (metodo === "select") pediuCount = (args[1] as { count?: string } | undefined)?.count === "exact";
          if (metodo === "range") faixa = [args[0] as number, args[1] as number];
          if (metodo === "limit") limite = args[0] as number;
          return c;
        };
      }
      c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        let r: unknown;
        if (tabela === "contacts") {
          const fatia = faixa ? contatos.slice(faixa[0], faixa[1] + 1) : contatos.slice(0, limite ?? undefined);
          r = { data: fatia.slice(0, maxRows), count: pediuCount ? contatos.length : null, error: null };
        } else {
          r = erroIdentidades
            ? { data: null, error: erroIdentidades }
            : { data: [{ contact_id: "insta" }, { contact_id: "de-fora-da-varredura" }], error: null };
        }
        return Promise.resolve(r).then(res, rej);
      };
      return c;
    },
  }),
}));

const rota = await import("@/app/api/v1/contacts/duplicates/route");
const GET = (url = "http://localhost/api/v1/contacts/duplicates") => rota.GET(new Request(url));

/** Um contato vivo, de nome técnico (não forma par por nome) e celular único, em `created_at` crescente. */
function contato(i: number, parcial: Linha = {}): Linha {
  const n = String(i).padStart(4, "0");
  return {
    id: `contato-${n}`,
    name: `Contato ${n}`,
    display_name: null,
    email: null,
    email_normalized: null,
    phone_number: `+553198${String(1000000 + i)}`,
    is_merged_into: null,
    is_anonymized: false,
    source_metadata: null,
    created_at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
    last_activity_at: null,
    ...parcial,
  };
}

/** `n` contatos, com o MESMO celular (com e sem o nono dígito) nos contatos 5 e 1500. */
function baseComPar(n: number): Linha[] {
  const linhas = Array.from({ length: n }, (_, k) => contato(k + 1));
  linhas[4] = contato(5, { phone_number: "+553198966398" });
  linhas[1499] = contato(1500, { phone_number: "+5531998966398" });
  return linhas;
}

type Corpo = {
  data: { motivos: string[]; principal_sugerido: string; contatos: { id: string }[] }[];
  meta: { varreu_tudo: boolean; contatos_varridos: number };
};

const faixasDeContatos = () =>
  chamadas.filter((c) => c.tabela === "contacts" && c.metodo === "range").map((c) => c.args);
const selectsDeContatos = () => chamadas.filter((c) => c.tabela === "contacts" && c.metodo === "select");

beforeEach(() => {
  chamadas = [];
  erroIdentidades = null;
  maxRows = 1000;
  contatos = PAR_INSTAGRAM_WHATSAPP;
  sessao.papel = "viewer";
  dispensa.pares.clear();
  dispensa.erro = false;
  dispensa.leituras = 0;
  vi.mocked(auditarLeitura).mockClear();
});

describe("GET /api/v1/contacts/duplicates — identidades do Instagram", () => {
  it("lê as identidades só por org + canal (sem lista de ids na URL) e acha o par", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const doInstagram = chamadas.filter((c) => c.tabela === "contact_channel_identities");
    expect(doInstagram.some((c) => c.metodo === "in")).toBe(false);
    expect(doInstagram).toContainEqual({ tabela: "contact_channel_identities", metodo: "eq", args: ["organization_id", "ORG"] });
    expect(doInstagram).toContainEqual({ tabela: "contact_channel_identities", metodo: "eq", args: ["channel", "instagram"] });
    const corpo = (await res.json()) as { data: { motivos: string[]; principal_sugerido: string }[] };
    expect(corpo.data).toHaveLength(1);
    expect(corpo.data[0]!.motivos).toContain("mesmo_nome_instagram_whatsapp");
    expect(corpo.data[0]!.principal_sugerido).toBe("zap");
  });

  it("não pede a coluna morta `source` de contatos", async () => {
    await GET();
    const select = chamadas.find((c) => c.tabela === "contacts" && c.metodo === "select");
    expect(String(select?.args[0])).not.toMatch(/\bsource\b(?!_)/);
  });

  it("erro ao ler as identidades não é engolido: 500", async () => {
    erroIdentidades = { message: "URI too long" };
    const res = await GET();
    expect(res.status).toBe(500);
  });
});

describe("GET /api/v1/contacts/duplicates — a varredura passa dos 1.000 do PostgREST (#2561)", () => {
  it("1.500 vivos: duas páginas por range, count só na 1ª, e o par além do 1.000º aparece", async () => {
    // Sabotagem: voltar ao `.limit(TETO + 1)` faz o servidor devolver só 1.000
    // linhas — o contato 1500 some, o par some, e este caso fica vermelho.
    contatos = baseComPar(1500);

    const res = await GET();
    const corpo = (await res.json()) as Corpo;

    expect(res.status).toBe(200);
    expect(faixasDeContatos()).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    const selects = selectsDeContatos();
    expect(selects[0]!.args[1]).toEqual({ count: "exact" });
    expect(selects.slice(1).every((s) => s.args[1] === undefined), "count só na primeira página").toBe(true);
    expect(chamadas.filter((c) => c.tabela === "contacts" && c.metodo === "order").map((c) => c.args[0])).toEqual([
      "created_at",
      "id",
      "created_at",
      "id",
    ]);
    expect(corpo.data).toHaveLength(1);
    expect(corpo.data[0]!.contatos.map((c) => c.id).sort()).toEqual(["contato-0005", "contato-1500"]);
    expect(corpo.meta).toEqual({ varreu_tudo: true, contatos_varridos: 1500 });
  });

  it("2.500 vivos: para no teto, varreu_tudo false e contatos_varridos 2000", async () => {
    contatos = baseComPar(2500);

    const corpo = (await (await GET()).json()) as Corpo;

    expect(faixasDeContatos()).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2000],
    ]);
    expect(corpo.meta).toEqual({ varreu_tudo: false, contatos_varridos: 2000 });
    expect(corpo.data[0]!.contatos.map((c) => c.id).sort()).toEqual(["contato-0005", "contato-1500"]);
  });

  it("max_rows MENOR que a página: página curta não é fim", async () => {
    // Sabotagem: tratar a página curta como fim para a leitura nos 300 primeiros
    // e o par (contatos 5 e 1500) some.
    maxRows = 300;
    contatos = baseComPar(2500);

    const corpo = (await (await GET()).json()) as Corpo;

    expect(corpo.meta).toEqual({ varreu_tudo: false, contatos_varridos: 2000 });
    expect(corpo.data[0]!.contatos.map((c) => c.id).sort()).toEqual(["contato-0005", "contato-1500"]);
  });
});

describe("GET /api/v1/contacts/duplicates — nome parecido, só para gestor (porte do #3640)", () => {
  /** Um grupo forte (o mesmo celular, com e sem o nono dígito) e um par só pelo nome. */
  function cenario(): Linha[] {
    const linhas = Array.from({ length: 60 }, (_, k) => contato(k + 1));
    linhas[4] = contato(5, { phone_number: "+553198966398" });
    linhas[5] = contato(6, { phone_number: "+5531998966398" });
    linhas[9] = contato(10, { name: "Clínica Santos Odontologia" });
    linhas[19] = contato(20, { name: "Santos Odontologia Clínica Avançada" });
    return linhas;
  }

  it("(3) gestor: o par por nome vem com motivos nome_parecido, DEPOIS do grupo forte", async () => {
    // Sabotagem: concatenar os parecidos ANTES dos fortes deixa a ordem vermelha.
    sessao.papel = "manager";
    contatos = cenario();

    const corpo = (await (await GET()).json()) as Corpo;

    expect(corpo.data.map((g) => g.motivos)).toEqual([["telefone"], ["nome_parecido"]]);
    expect(corpo.data[1]!.contatos.map((c) => c.id)).toEqual(["contato-0010", "contato-0020"]);
    expect(dispensa.leituras).toBe(1);
  });

  it("(4) par dispensado, gravado com os ids invertidos, não aparece", async () => {
    // Sabotagem: ignorar `lerParesDispensados` deixa o par de nome na lista.
    sessao.papel = "manager";
    contatos = cenario();
    dispensa.pares.add(parDeContatos("contato-0020", "contato-0010"));

    const corpo = (await (await GET()).json()) as Corpo;

    expect(corpo.data.map((g) => g.motivos)).toEqual([["telefone"]]);
  });

  it.each(["viewer", "agent"])("(5) %s: nada de nome_parecido, e as dispensas nem são lidas", async (papel) => {
    // Sabotagem: calcular os parecidos para todo papel deixa este caso vermelho.
    sessao.papel = papel;
    contatos = cenario();

    const corpo = (await (await GET()).json()) as Corpo;

    expect(corpo.data.map((g) => g.motivos)).toEqual([["telefone"]]);
    expect(dispensa.leituras).toBe(0);
  });

  it("(6) erro ao ler as dispensas: 500 sem a lista (um par dispensado não volta calado)", async () => {
    sessao.papel = "manager";
    contatos = cenario();
    dispensa.erro = true;

    const res = await GET();
    const corpo = (await res.json()) as { data?: unknown; error?: { code: string; message: string } };

    expect(res.status).toBe(500);
    expect(corpo.data).toBeUndefined();
    expect(corpo.error?.code).toBe("internal_error");
    expect(corpo.error?.message).not.toMatch(/merge_queue/);
  });

  it("(7) a abertura com grupos deixa UMA linha contact.listed com os ids; recarga e lista vazia, nenhuma", async () => {
    // Sabotagem: auditar sem olhar `ehAberturaDeLeitura` faz a recarga marcada gravar outra linha.
    sessao.papel = "manager";
    contatos = cenario();

    await GET();
    expect(auditarLeitura).toHaveBeenCalledTimes(1);
    expect(vi.mocked(auditarLeitura).mock.calls[0]![0]).toMatchObject({
      action: "contact.listed",
      actorUserId: "U1",
      organizationId: "ORG",
      resourceType: "contact",
      metadata: { recurso: "duplicados", ids: ["contato-0005", "contato-0006", "contato-0010", "contato-0020"] },
    });

    vi.mocked(auditarLeitura).mockClear();
    await GET("http://localhost/api/v1/contacts/duplicates?atualizacao=1");
    expect(auditarLeitura).not.toHaveBeenCalled();

    contatos = Array.from({ length: 10 }, (_, k) => contato(k + 1));
    await GET();
    expect(auditarLeitura).not.toHaveBeenCalled();
  });
});
