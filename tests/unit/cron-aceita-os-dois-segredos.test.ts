import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

// Os dois segredos DIFERENTES, como o `install.sh` do kit os grava no `.env`.
vi.mock("@/lib/env", () => ({
  env: { INTERNAL_SECRET: "segredo-do-agendador", INTERNAL_CRON_SECRET: "segredo-do-cron" },
}));
// O banco não importa aqui: só se a rota passa do portão. Falhar depois dele é 500.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("sem banco no teste");
  },
}));

/**
 * Cerca de CLASSE, não de instância.
 *
 * O `install.sh` do kit gera `INTERNAL_SECRET` e `INTERNAL_CRON_SECRET` com
 * valores DIFERENTES e grava os dois no `.env`; o `crond` do serviço `scheduler`
 * chama as rotas com `Bearer $INTERNAL_SECRET` (`docker/scheduler/entrypoint.sh`).
 * Uma rota que aceite só o PRIMEIRO segredo definido responde 401 em toda
 * instalação — e o `curl` do crontab descarta a saída, então o 401 diário não
 * aparece em log nenhum. Foi o que aconteceu com `sync-model-catalog`, que ficou
 * um ano assim porque o único lugar que registrava a divergência era um arquivo
 * de configuração de plataforma, depois apagado.
 *
 * Este teste não confere a rota consertada: confere que NENHUMA rota volta ao
 * padrão. Para ver o portão compartilhado: `lib/auth/cron-auth.ts`.
 */
const DIR_CRON = join(__dirname, "..", "..", "app", "api", "v1", "cron");

/** `INTERNAL_CRON_SECRET || INTERNAL_SECRET` e parentes: aceita só o primeiro. */
const SO_O_PRIMEIRO = /INTERNAL_CRON_SECRET\s*(\|\||\?\?)\s*env\.INTERNAL_SECRET/;

function rotasDeCron(): { nome: string; fonte: string }[] {
  return readdirSync(DIR_CRON, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ nome: e.name, fonte: readFileSync(join(DIR_CRON, e.name, "route.ts"), "utf8") }))
    .sort((a, b) => a.nome.localeCompare(b.nome));
}

describe("autenticação das rotas de cron", () => {
  it("nenhuma rota aceita só o primeiro dos dois segredos", () => {
    const culpadas = rotasDeCron()
      .filter((r) => SO_O_PRIMEIRO.test(r.fonte))
      .map((r) => r.nome);

    expect(
      culpadas,
      "Rota(s) que só aceitam o primeiro segredo definido: " +
        `${culpadas.join(", ")}. O scheduler manda Bearer $INTERNAL_SECRET e elas ` +
        "responderiam 401 em silêncio. Use autorizaCron() de lib/auth/cron-auth.ts.",
    ).toEqual([]);
  });

  it("toda rota confere o Bearer contra os DOIS segredos", () => {
    // Exige o padrão no CÓDIGO, não em comentário: ou a rota chama o portão
    // compartilhado, ou os dois segredos aparecem com o prefixo `env.` na mesma
    // expressão. A primeira versão desta asserção pedia só as duas PALAVRAS em
    // qualquer lugar do arquivo — e uma sabotagem que trocou a auth por uma
    // string literal passou, porque as palavras sobraram no comentário de cima.
    const DOIS_NO_CODIGO = /env\.INTERNAL_CRON_SECRET[\s\S]{0,300}env\.INTERNAL_SECRET/;
    const semOsDois = rotasDeCron()
      .filter((r) => !r.fonte.includes("autorizaCron(") && !DOIS_NO_CODIGO.test(r.fonte))
      .map((r) => r.nome);

    expect(
      semOsDois,
      `Rota(s) de cron sem os dois segredos no caminho de auth: ${semOsDois.join(", ")}.`,
    ).toEqual([]);
  });

  it("o inventário não está vazio — senão os dois casos acima passam por vacuidade", () => {
    expect(rotasDeCron().length).toBeGreaterThan(20);
  });
});

describe("sync-model-catalog com os dois segredos diferentes (fork, porte do 71e14ce8c)", () => {
  async function chamar(bearer: string): Promise<number> {
    const { GET } = await import("@/app/api/v1/cron/sync-model-catalog/route");
    const req = new NextRequest("http://local/api/v1/cron/sync-model-catalog", {
      headers: { authorization: `Bearer ${bearer}` },
    });
    return (await GET(req)).status;
  }

  it("o segredo que o agendador manda (INTERNAL_SECRET) passa do portão", async () => {
    expect(await chamar("segredo-do-agendador")).not.toBe(401);
  });

  it("o INTERNAL_CRON_SECRET continua aceito, e um segredo errado continua recusado", async () => {
    expect(await chamar("segredo-do-cron")).not.toBe(401);
    expect(await chamar("segredo-errado")).toBe(401);
  });
});
