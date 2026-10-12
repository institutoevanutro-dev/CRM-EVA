/**
 * TESTE DE FRASES DO JEV — sem dado de paciente, sem banco.
 *
 * Manda ao Jev as frases escritas à mão de `scripts/lib/jev-frases-de-clinica.ts`,
 * pelo MESMO cliente, as mesmas perguntas, a mesma limpeza e os mesmos cortes
 * do worker de clima, e imprime por tarefa: pegos, perdidos, alarmes falsos, as
 * frases em que ele errou e a latência. Não lê nem escreve no banco, não abre
 * aviso, não manda mensagem a ninguém.
 *
 * Usa `JEV_API_KEY` (e `JEV_API_BASE_URL`, se houver) do ambiente. Sem chave,
 * sai com código 2 sem fazer chamada nenhuma. Custo: uma chamada por frase.
 *
 * ─── Uso ────────────────────────────────────────────────────────────────────
 *
 *   # na VPS, dentro do contêiner do worker (o do app não tem tsx nem scripts/)
 *   docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml --env-file .env \
 *     exec worker pnpm exec tsx scripts/jev-teste-de-frases.ts
 *
 *   # local
 *   tsx --env-file=.env.local scripts/jev-teste-de-frases.ts
 */
import { FRASES_DE_CLINICA } from "./lib/jev-frases-de-clinica";
import { medirFrase, relatorio, type Medida, type Perguntar } from "./lib/jev-teste-de-frases";

async function main(): Promise<number> {
  const chave = (process.env.JEV_API_KEY ?? "").trim();
  if (chave === "") {
    console.error("JEV_API_KEY não está no ambiente: nada foi enviado.");
    return 2;
  }
  // Só depois da chave: estes módulos validam o ambiente inteiro ao carregar
  // (`lib/env.ts`), e sem chave a saída tem de ser a de cima, não a deles.
  const { allowlistedFetch, buildAllowlist } = await import("../lib/agent-engine/edge/egress");
  const { baseDaApiDoJev, decidir } = await import("../lib/ai/decisao/cliente");
  const { pedidosQueARegraViu } = await import("../workers/ai-sentiment-worker.jev");
  const base = baseDaApiDoJev();
  const allowlist = buildAllowlist([base]);
  const perguntar: Perguntar = (estado, perguntas) =>
    decidir(
      { chave, estado, perguntas },
      {
        baseUrl: base,
        fetchImpl: ((url: string | URL, init?: RequestInit) => allowlistedFetch(url, init, { allowlist })) as typeof fetch,
      },
    );

  console.info(`Jev em ${base}: ${FRASES_DE_CLINICA.length} frases escritas à mão, uma chamada por frase.\n`);
  const medidas: Medida[] = [];
  for (const frase of FRASES_DE_CLINICA) medidas.push(await medirFrase(frase, perguntar, pedidosQueARegraViu));
  console.info(relatorio(medidas));
  return medidas.every((m) => m.falha !== null) ? 1 : 0;
}

main()
  .then((codigo) => process.exit(codigo))
  .catch((erro) => {
    console.error(erro instanceof Error ? erro.message : erro);
    process.exit(1);
  });
