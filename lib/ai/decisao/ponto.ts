/**
 * O PONTO DO JEV — a única porta entre o sistema e o System One.
 *
 * Porte enxuto de melgarafael/DeskcommCRM #1575/#1696 (`ponto.ts`). Garante,
 * nesta ordem, sem depender de quem chama:
 *
 *  1. **Sem `JEV_API_KEY`, nada sai da máquina.** É a primeira linha, antes de
 *     ler qualquer config: o estado de toda instalação é este, e ele custa zero
 *     requisição (provado em `ponto.test.ts`). No upstream a chave é por
 *     organização, cadastrada na tela; aqui é uma chave da INSTALAÇÃO, porque
 *     o fork é self-host de uma clínica só. Numa instalação com várias
 *     organizações, todas usariam a mesma conta da TypeSafe.
 *  2. **Cadastrar a chave não é consentir.** Só pergunta a tarefa `observando`
 *     da organização que ligou o Jev e tem o aceite do administrador
 *     (`./config.ts`). As outras perguntas são descartadas aqui.
 *  3. **O destino passa pela allowlist de egress**, derivada da mesma base.
 *  4. **Depois de falhar, o disjuntor segura** (`./disjuntor.ts`).
 *  5. **Nunca lança.**
 *
 * O texto (`estado`) chega aqui já limpo: quem chama passa `scrubMessage`.
 */
import { allowlistedFetch, buildAllowlist } from "@/lib/agent-engine/edge/egress";
import { env } from "@/lib/env";

import { baseDaApiDoJev, decidir, type FalhaDaDecisao, type Pergunta, type ResultadoDaDecisao } from "./cliente";
import { estadoEfetivo, lerConfigDoJev, type IdDaTarefa } from "./config";
import { podeTentar, registrarFalha, registrarSucesso } from "./disjuntor";

export interface EntradaDoPonto {
  organizationId: string;
  /** `organizations.settings` como lido do banco. */
  settings: unknown;
  /** Uma mensagem, já passada por `scrubMessage`. */
  estado: string;
  /** Cada pergunta é de uma tarefa, pelo id. */
  perguntas: Partial<Record<IdDaTarefa, Pergunta>>;
}

export type ResultadoDoPonto =
  | ResultadoDaDecisao
  | { ok: false; motivo: "desligado"; exigeAcao: false; defeitoNosso: false; status: null };

const SEM_REDE = { exigeAcao: false, defeitoNosso: false, status: null } as const;

/** Há chave da instalação? Leitura pura do ambiente, sem rede. */
export function jevTemChave(): boolean {
  return (env.JEV_API_KEY ?? "").trim() !== "";
}

export async function perguntarAoJev(e: EntradaDoPonto): Promise<ResultadoDoPonto> {
  const chave = (env.JEV_API_KEY ?? "").trim();
  if (chave === "") return { ok: false, motivo: "sem_credencial", ...SEM_REDE };

  const config = lerConfigDoJev(e.settings);
  const perguntas: Record<string, Pergunta> = {};
  for (const [tarefa, pergunta] of Object.entries(e.perguntas) as Array<[IdDaTarefa, Pergunta | undefined]>) {
    if (pergunta !== undefined && estadoEfetivo(config, tarefa) === "observando") perguntas[tarefa] = pergunta;
  }
  if (Object.keys(perguntas).length === 0) return { ok: false, motivo: "desligado", ...SEM_REDE };

  if (!podeTentar(e.organizationId)) return { ok: false, motivo: "disjuntor_aberto", ...SEM_REDE };

  const base = baseDaApiDoJev();
  const allowlist = buildAllowlist([base]);
  const r = await decidir(
    { chave, estado: e.estado, perguntas },
    {
      baseUrl: base,
      fetchImpl: ((url: string | URL, init?: RequestInit) =>
        allowlistedFetch(url, init, { allowlist })) as typeof fetch,
    },
  );
  if (r.ok) registrarSucesso(e.organizationId);
  else registrarFalha(e.organizationId, r as FalhaDaDecisao);
  return r;
}
