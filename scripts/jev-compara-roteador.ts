/**
 * O JEV SERIA UM BOM ROTEADOR? Comparação offline, sem dado de paciente, sem banco.
 *
 * Manda ao Jev os 45 casos inventados de `scripts/lib/jev-bateria-do-roteador.ts`
 * do jeito que o upstream o faz rotear (uma pergunta de escolha por mensagem,
 * ver `scripts/lib/jev-compara-roteador.ts`) e imprime: acertos no total, por
 * assunto e por cenário de contato, os casos errados com as duas maiores
 * probabilidades, a latência e o custo em chamadas. O roteador atual fez 44 de
 * 45 nesta bateria em 12/10/2026. Não lê nem escreve no banco, não abre aviso,
 * não manda mensagem a ninguém, não muda roteador nenhum.
 *
 * Usa `JEV_API_KEY` (e `JEV_API_BASE_URL`, se houver) do ambiente. Sem chave,
 * sai com código 2 sem fazer chamada nenhuma. Custo: uma chamada por caso.
 *
 * ─── Uso ────────────────────────────────────────────────────────────────────
 *
 *   # na VPS, dentro do contêiner do worker (o do app não tem tsx nem scripts/)
 *   docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml --env-file .env \
 *     exec worker pnpm exec tsx scripts/jev-compara-roteador.ts
 *
 *   --sem-fatos       só a mensagem no estado, como no upstream (padrão: com os fatos da agenda)
 *   --limite N        só os N primeiros casos (teste de fumaça)
 *   --membros ARQ     JSON com os membros do roteador de produção
 *                     ([{ intent_name, intent_description, examples }]), para o Jev
 *                     receber a mesma descrição e os mesmos exemplos do roteador
 *                     atual. Sem isto, vale a descrição curta da bateria.
 *
 *   # local
 *   tsx --env-file=.env.local scripts/jev-compara-roteador.ts --limite 5
 */
import { readFileSync } from "node:fs";

import { CASOS_DO_ROTEADOR, MINIMO_DO_ROTEADOR } from "./lib/jev-bateria-do-roteador";
import {
  lerArgumentos,
  lerMembros,
  medirCaso,
  MEMBROS_DA_BATERIA,
  relatorio,
  type Medida,
  type Membro,
  type Perguntar,
} from "./lib/jev-compara-roteador";

/** Pausa entre as chamadas: a bateria não pode parecer rajada ao fornecedor. */
const PAUSA_MS = 200;

export async function main(argv: readonly string[], ambiente: NodeJS.ProcessEnv = process.env): Promise<number> {
  const args = lerArgumentos(argv);
  if (typeof args === "string") {
    console.error(args);
    return 2;
  }
  const chave = (ambiente.JEV_API_KEY ?? "").trim();
  if (chave === "") {
    console.error("JEV_API_KEY não está no ambiente: nada foi enviado.");
    return 2;
  }
  let membros: readonly Membro[] = MEMBROS_DA_BATERIA;
  if (args.membros !== null) {
    let lidos: Membro[] | string;
    try {
      lidos = lerMembros(JSON.parse(readFileSync(args.membros, "utf8")));
    } catch (erro) {
      lidos = erro instanceof Error ? erro.message : "arquivo ilegível";
    }
    if (typeof lidos === "string") {
      console.error(`--membros ${args.membros}: ${lidos}. Nada foi enviado.`);
      return 2;
    }
    membros = lidos;
  }
  // Só depois da chave: estes módulos validam o ambiente inteiro ao carregar
  // (`lib/env.ts`), e sem chave a saída tem de ser a de cima, não a deles.
  const { allowlistedFetch, buildAllowlist } = await import("../lib/agent-engine/edge/egress");
  const { baseDaApiDoJev, decidir } = await import("../lib/ai/decisao/cliente");
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

  const casos = CASOS_DO_ROTEADOR.slice(0, args.limite ?? CASOS_DO_ROTEADOR.length);
  const comFatos = !args.semFatos;
  console.info(
    `Jev em ${base}: ${casos.length} casos inventados, uma chamada por caso, ${comFatos ? "com" : "sem"} os fatos da agenda, ` +
      `${args.membros === null ? "descrições da bateria" : `membros de ${args.membros}`}.\n`,
  );
  const medidas: Medida[] = [];
  for (const caso of casos) {
    if (medidas.length > 0) await new Promise((r) => setTimeout(r, PAUSA_MS));
    medidas.push(await medirCaso(caso, membros, comFatos, perguntar));
  }
  console.info(relatorio(medidas, { minimo: MINIMO_DO_ROTEADOR, comFatos }));
  return medidas.every((m) => m.falha !== null) ? 1 : 0;
}

// Só roda quando é o arquivo chamado: o teste importa `main` sem disparar nada.
if (/jev-compara-roteador\.ts$/.test(process.argv[1] ?? "")) {
  main(process.argv.slice(2))
    .then((codigo) => process.exit(codigo))
    .catch((erro) => {
      console.error(erro instanceof Error ? erro.message : erro);
      process.exit(1);
    });
}
