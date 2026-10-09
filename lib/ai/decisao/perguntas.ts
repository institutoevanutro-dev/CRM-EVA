/**
 * AS PERGUNTAS DO JEV NA FASE 1, e como cada resposta vira rótulo.
 *
 * Porte de melgarafael/DeskcommCRM: a escala do clima com a separação entre
 * RELATO do problema e RECLAMAÇÃO do atendimento (#2248, 0b69b2d0) e as duas
 * perguntas de pedido do cliente com os cortes medidos no upstream (#1747,
 * b46e320c). Nenhum rótulo daqui decide nada: vira linha em `jev_observacoes`.
 */
import type { Pergunta, Resposta } from "./cliente";

/**
 * Do pior ao melhor: a ordem É o contrato do `score`. Insatisfação com o
 * ATENDIMENTO fica no nível 1 (0,25, abaixo do limiar padrão de 0,3); o RELATO
 * do problema no nível 2 (0,5). Numa clínica, "estou com dor desde a cirurgia"
 * é relato, não reclamação.
 */
export const NIVEIS_DE_CLIMA = [
  "cliente irritado, revoltado ou ameaçando sair — hostilidade aberta com quem responde: ameaça, xingamento ou pedido agressivo de falar com uma pessoa",
  "cliente insatisfeito COM O ATENDIMENTO, sem hostilidade aberta — reclamando de demora, de resposta que não resolve ou de cobrança fechada",
  "cliente apenas relatando o problema que o trouxe até aqui ou trocando informação, sem irritação com quem responde (ex.: \"estou com dor desde a cirurgia\")",
  "cliente satisfeito ou colaborativo",
  "cliente entusiasmado, elogiando ou agradecendo",
] as const;

export const PERGUNTA_DO_CLIMA: Pergunta = {
  tipo: "score",
  instrucao:
    "Com base na ÚLTIMA mensagem do cliente, em que ponto está o clima da conversa? Meça a hostilidade com o ATENDIMENTO, não o assunto: relatar o problema que a pessoa descreve é informação, não reclamação.",
  criterios: NIVEIS_DE_CLIMA,
};

/** Nota de 0 (irritado) a 1, na régua de `messages.metadata.sentiment_score`. `null` = fora da escala. */
export function notaDoClima(r: Resposta | undefined): { nota: number; confianca: number } | null {
  if (r?.tipo !== "score") return null;
  const teto = NIVEIS_DE_CLIMA.length - 1;
  if (!Number.isFinite(r.score) || r.score < 0 || r.score > teto) return null;
  return { nota: r.score / teto, confianca: r.confianca };
}

/** O rótulo que entra na concordância: abaixo do limiar do agente, a IA de sempre passaria a conversa. */
export function rotuloDoClima(nota: number, limiar: number): "reclamando" | "ok" {
  return nota < limiar ? "reclamando" : "ok";
}

export type IdDoPedido = "humano" | "opt_out";

/** Cortes medidos no upstream com a chave real (#1747): pessoa 0,9; parar 0,8. */
export const CORTE_DO_PEDIDO = { humano: 0.9, opt_out: 0.8 } as const satisfies Record<IdDoPedido, number>;

export const PERGUNTAS_DOS_PEDIDOS: Record<IdDoPedido, Pergunta> = {
  humano: {
    tipo: "noul",
    instrucao:
      "A ÚLTIMA mensagem do cliente pede para ser atendido por uma pessoa, e não pelo assistente automático, em qualquer idioma?",
    criterios: {
      true: "Pede para falar com uma pessoa, um atendente, o dono, o gerente ou alguém de verdade, ou diz que não quer falar com robô.",
      false: "Qualquer outra coisa: pergunta, pedido, reclamação ou elogio, sem pedir para falar com uma pessoa.",
    },
  },
  opt_out: {
    tipo: "noul",
    instrucao: "A ÚLTIMA mensagem do cliente pede para parar de receber mensagens desta empresa, em qualquer idioma?",
    criterios: {
      true: "Pede para não ser mais contatado: parar de mandar mensagens, sair da lista, descadastrar, não receber mais nada.",
      false:
        "Qualquer outra coisa — inclusive parar ou sair em outro sentido, como parar uma dor, sair mais cedo ou dar baixa num pedido.",
    },
  },
};

/** Probabilidade do "sim", ou `null` se a resposta não é um noul válido. */
export function probabilidadeDoSim(r: Resposta | undefined): number | null {
  if (r?.tipo !== "noul") return null;
  return Number.isFinite(r.noul) && r.noul >= 0 && r.noul <= 1 ? r.noul : null;
}

export function rotuloDoPedido(id: IdDoPedido, prob: number): "sim" | "nao" {
  return prob >= CORTE_DO_PEDIDO[id] ? "sim" : "nao";
}
