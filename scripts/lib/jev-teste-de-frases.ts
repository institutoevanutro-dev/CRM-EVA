/**
 * A CONTA do `scripts/jev-teste-de-frases.ts`, separada do encanamento (env,
 * rede, `process.exit`) para ser testável com um cliente de mentira.
 *
 * Mede cada frase do jeito que o worker de clima a mede
 * (`workers/ai-sentiment-worker.jev.ts`): mesma limpeza (`scrubMessage`), as
 * mesmas perguntas (`lib/ai/decisao/perguntas.ts`), os pedidos perguntados só
 * onde a REGRA do fork disse não, os mesmos cortes. Não toca no banco.
 */
import {
  notaDoClima,
  PERGUNTA_DO_CLIMA,
  PERGUNTAS_DOS_PEDIDOS,
  probabilidadeDoSim,
  rotuloDoClima,
  rotuloDoPedido,
  type IdDoPedido,
} from "../../lib/ai/decisao/perguntas";
import type { Pergunta, ResultadoDaDecisao } from "../../lib/ai/decisao/cliente";
import { scrubMessage } from "../../lib/sentry/scrub";

import type { Frase } from "./jev-frases-de-clinica";

/** O limiar padrão do agente para o clima (`sentiment_threshold`), o mesmo do worker. */
export const LIMIAR_DO_CLIMA = 0.3;

export type Perguntar = (estado: string, perguntas: Record<string, Pergunta>) => Promise<ResultadoDaDecisao>;
export type Regra = (mensagem: string) => Record<IdDoPedido, boolean>;

export interface Medida {
  frase: Frase;
  /** O que a regra do fork viu. Onde ela viu, o Jev não é perguntado. */
  regra: Record<IdDoPedido, boolean>;
  /** Probabilidade do "sim" por pedido; `null` = não perguntado ou sem resposta. */
  jev: Record<IdDoPedido, number | null>;
  /** Nota do clima de 0 (irritado) a 1; `null` = sem resposta. */
  clima: number | null;
  latenciaMs: number | null;
  /** Motivo da falha da chamada, se houve. */
  falha: string | null;
}

export async function medirFrase(frase: Frase, perguntar: Perguntar, regra: Regra): Promise<Medida> {
  const viu = regra(frase.texto);
  const perguntas: Record<string, Pergunta> = { clima: PERGUNTA_DO_CLIMA };
  for (const id of ["humano", "opt_out"] as const) if (!viu[id]) perguntas[id] = PERGUNTAS_DOS_PEDIDOS[id];
  const r = await perguntar(scrubMessage(frase.texto), perguntas);
  if (!r.ok) {
    return { frase, regra: viu, jev: { humano: null, opt_out: null }, clima: null, latenciaMs: r.latenciaMs ?? null, falha: r.motivo };
  }
  return {
    frase,
    regra: viu,
    jev: {
      humano: viu.humano ? null : probabilidadeDoSim(r.respostas.humano),
      opt_out: viu.opt_out ? null : probabilidadeDoSim(r.respostas.opt_out),
    },
    clima: notaDoClima(r.respostas.clima)?.nota ?? null,
    latenciaMs: r.latenciaMs,
    falha: null,
  };
}

export interface Erro {
  texto: string;
  /** O que aconteceu, em uma palavra, e o número que o Jev deu. */
  oQue: string;
}

export interface Placar {
  tarefa: "opt_out" | "humano" | "clima";
  /** Positivos esperados que alguém pegou. Nos pedidos, separados por quem pegou. */
  acertos: number;
  acertosDaRegra: number;
  /** Positivos esperados que ninguém pegou. */
  perdidos: number;
  /** Negativos esperados em que o Jev disse sim (abriria aviso à toa). */
  alarmesFalsos: number;
  /** Negativos esperados em que a REGRA disse sim: defeito da regra, não do Jev. */
  alarmesFalsosDaRegra: number;
  /** Negativos esperados que ninguém acusou. */
  negativosCertos: number;
  /** Frases com rótulo certo em que o Jev não respondeu. */
  semResposta: number;
  ambiguas: Erro[];
  erros: Erro[];
}

const n = (v: number | null) => (v === null ? "sem resposta" : v.toFixed(2));

function placarVazio(tarefa: Placar["tarefa"]): Placar {
  return {
    tarefa,
    acertos: 0,
    acertosDaRegra: 0,
    perdidos: 0,
    alarmesFalsos: 0,
    alarmesFalsosDaRegra: 0,
    negativosCertos: 0,
    semResposta: 0,
    ambiguas: [],
    erros: [],
  };
}

export function pontuarPedido(id: IdDoPedido, medidas: readonly Medida[]): Placar {
  const p = placarVazio(id);
  for (const m of medidas) {
    const esperado = m.frase[id];
    const prob = m.jev[id];
    const jevDisseSim = prob !== null && rotuloDoPedido(id, prob) === "sim";
    const texto = m.frase.texto;
    if (esperado === "ambiguo") {
      p.ambiguas.push({ texto, oQue: m.regra[id] ? "a regra pegou" : `Jev ${n(prob)}` });
    } else if (m.regra[id]) {
      if (esperado === "sim") {
        p.acertos += 1;
        p.acertosDaRegra += 1;
      } else {
        p.alarmesFalsosDaRegra += 1;
        p.erros.push({ texto, oQue: "a REGRA pegou o que não era pedido" });
      }
    } else if (prob === null) {
      p.semResposta += 1;
    } else if (esperado === "sim") {
      if (jevDisseSim) p.acertos += 1;
      else {
        p.perdidos += 1;
        p.erros.push({ texto, oQue: `perdido (Jev ${n(prob)})` });
      }
    } else if (jevDisseSim) {
      p.alarmesFalsos += 1;
      p.erros.push({ texto, oQue: `alarme falso (Jev ${n(prob)})` });
    } else {
      p.negativosCertos += 1;
    }
  }
  return p;
}

export function pontuarClima(medidas: readonly Medida[], limiar: number = LIMIAR_DO_CLIMA): Placar {
  const p = placarVazio("clima");
  for (const m of medidas) {
    const esperado = m.frase.clima;
    const texto = m.frase.texto;
    if (esperado === "ambiguo") {
      p.ambiguas.push({ texto, oQue: `nota ${n(m.clima)}` });
    } else if (m.clima === null) {
      p.semResposta += 1;
    } else {
      const jev = rotuloDoClima(m.clima, limiar);
      if (esperado === "reclamando" && jev === "reclamando") p.acertos += 1;
      else if (esperado === "reclamando") {
        p.perdidos += 1;
        p.erros.push({ texto, oQue: `reclamação perdida (nota ${n(m.clima)})` });
      } else if (jev === "reclamando") {
        p.alarmesFalsos += 1;
        p.erros.push({ texto, oQue: `alarme falso (nota ${n(m.clima)})` });
      } else p.negativosCertos += 1;
    }
  }
  return p;
}

export interface Latencia {
  chamadas: number;
  falhas: number;
  medianaMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export function resumirLatencia(medidas: readonly Medida[]): Latencia {
  const ms = medidas
    .filter((m) => m.falha === null && m.latenciaMs !== null)
    .map((m) => m.latenciaMs as number)
    .sort((a, b) => a - b);
  const em = (q: number) => (ms.length === 0 ? null : ms[Math.min(ms.length - 1, Math.ceil(q * ms.length) - 1)]!);
  return {
    chamadas: medidas.length,
    falhas: medidas.filter((m) => m.falha !== null).length,
    medianaMs: em(0.5),
    p95Ms: em(0.95),
    maxMs: ms.length === 0 ? null : ms[ms.length - 1]!,
  };
}

const NOME = {
  opt_out: "PARAR DE RECEBER (corte 0,80)",
  humano: "FALAR COM UMA PESSOA (corte 0,90)",
  clima: `CLIMA (reclamando = nota abaixo de ${LIMIAR_DO_CLIMA})`,
} as const;

/** A tabela de um placar, em texto. */
export function tabela(p: Placar): string {
  const linhas = [
    `── ${NOME[p.tarefa]} ──`,
    `  esperado SIM  | pegos: ${p.acertos}${p.tarefa === "clima" ? "" : ` (regra ${p.acertosDaRegra}, Jev ${p.acertos - p.acertosDaRegra})`} | perdidos: ${p.perdidos}`,
    `  esperado NÃO  | certos: ${p.negativosCertos} | alarmes falsos do Jev: ${p.alarmesFalsos}${p.tarefa === "clima" ? "" : ` | da regra: ${p.alarmesFalsosDaRegra}`}`,
    `  sem resposta do Jev: ${p.semResposta} | ambíguas (fora da conta): ${p.ambiguas.length}`,
  ];
  if (p.erros.length > 0) linhas.push("  ERROS:", ...p.erros.map((e) => `    - "${e.texto}": ${e.oQue}`));
  if (p.ambiguas.length > 0) linhas.push("  AMBÍGUAS:", ...p.ambiguas.map((e) => `    - "${e.texto}": ${e.oQue}`));
  return linhas.join("\n");
}

export function relatorio(medidas: readonly Medida[]): string {
  const l = resumirLatencia(medidas);
  const falhas = new Map<string, number>();
  for (const m of medidas) if (m.falha !== null) falhas.set(m.falha, (falhas.get(m.falha) ?? 0) + 1);
  return [
    tabela(pontuarPedido("opt_out", medidas)),
    tabela(pontuarPedido("humano", medidas)),
    tabela(pontuarClima(medidas)),
    "── LATÊNCIA ──",
    `  chamadas: ${l.chamadas} | falhas: ${l.falhas}${l.falhas > 0 ? ` (${[...falhas].map(([m, q]) => `${m}: ${q}`).join(", ")})` : ""}`,
    `  mediana: ${l.medianaMs ?? "-"} ms | p95: ${l.p95Ms ?? "-"} ms | máxima: ${l.maxMs ?? "-"} ms`,
  ].join("\n");
}
