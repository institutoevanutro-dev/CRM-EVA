/**
 * Condições do motor de regras: filtros simples (eq/neq/contains) em AND.
 * Campo ausente = condição falsa (nunca erro). Coerção via String() dos dois
 * lados — o value vem sempre como string da UI.
 */
export type ConditionOp = "eq" | "neq" | "contains";

export interface RuleCondition {
  field: string;
  op: ConditionOp;
  value: string;
}

/**
 * A forma sobre a qual `contains` compara, nos DOIS lados (o valor da regra e o
 * texto recebido): minúsculas, sem acento, e a pontuação trocada por espaço.
 *
 * Sem caixa já era o comportamento; sem acento não era, e a regra que não casa
 * não dá erro nem aviso. Quem escreve a regra digita "anúncio" e o lead manda
 * "anuncio" (ou o contrário); "Olá" só casava "Olá", nunca "Ola" nem "olá!".
 *
 * `NFD` separa a letra do sinal e a faixa `\u0300-\u036f` tira só o acento.
 * NÃO use `\p{M}` às cegas: ele comeria o `U+FE0F` que fecha emoji como o
 * coração. A pontuação vira ESPAÇO (e os espaços se juntam): "pré-venda" casa
 * "pre venda", mas "10,00" não vira "1000" nem "@gmail.com" vira "gmailcom".
 */
export function normalizarParaContains(valor: unknown): string {
  return String(valor)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\p{P}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Regra que a normalização esvazia (feita só de pontuação, como "?") compara
 * como antes, só sem caixa: com o alvo vazio, "contém" casaria TODA mensagem, e
 * uma regra que manda WhatsApp passaria a disparar para todo mundo depois de uma
 * atualização.
 */
function formaDaRegra(valorDaRegra: string): (valor: unknown) => string {
  return normalizarParaContains(valorDaRegra) === ""
    ? (valor) => String(valor).toLowerCase()
    : normalizarParaContains;
}

export function resolveField(context: Record<string, unknown>, path: string): unknown {
  let cur: unknown = context;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function matches(cond: RuleCondition, context: Record<string, unknown>): boolean {
  const raw = resolveField(context, cond.field);
  if (raw === undefined || raw === null) return cond.op === "neq";
  if (cond.op === "contains") {
    // Um operador, um significado (#956). Em lista ele exigia a tag IDÊNTICA,
    // com caixa, enquanto em texto já era "contém" sem caixa — e a tela chama os
    // dois de "contém". Quem escreve a regra digita "Google" e a tag guardada é
    // `google` (o editor do Inbox grava em minúsculas) ou `google ads`.
    // Os dois lados passam pela MESMA forma (`formaDaRegra`), em lista e em texto.
    const forma = formaDaRegra(cond.value);
    const alvo = forma(cond.value);
    // Em LISTA o operador é pertinência: a tag inteira. A normalização acerta só
    // a GRAFIA da tag ("tráfego" acha `trafego`), nunca o pedaço dela.
    // Decisão do dono do produto (16/09, issue #956): "Google" pega `google` e
    // NÃO pega `google ads`, porque uma atualização não pode fazer uma regra
    // que dispara WhatsApp alcançar quem ela não alcançava. Em TEXTO segue
    // sendo "contém" de verdade — é o que o campo `event.event_type_name`
    // usa para "Manutenção" pegar os três tipos de atendimento.
    if (Array.isArray(raw)) return raw.some((item) => forma(item) === alvo);
    return forma(raw).includes(alvo);
  }
  const equal = String(raw) === cond.value;
  return cond.op === "eq" ? equal : !equal;
}

export function evaluateConditions(
  conditions: RuleCondition[],
  context: Record<string, unknown>,
): boolean {
  return conditions.every((c) => matches(c, context));
}
