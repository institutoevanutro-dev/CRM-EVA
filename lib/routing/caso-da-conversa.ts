/**
 * O CASO DA CONVERSA E A FILA DE ROTEAMENTO — a regra pura.
 *
 * Portado do projeto original (DeskcommCRM, PR #3739, issue #3717).
 *
 * ## O defeito que isto fecha
 *
 * Abrir um caso (`agent_cases`) não muda `conversations.status` nem o dono: a
 * conversa segue `open`/`pending`/`ai_handling` e sem atendente, e a IA pode
 * seguir respondendo e resolver o assunto sem que ninguém feche o caso. A
 * elegibilidade do rodízio (`fn_wake_channel_routing`, `lib/routing/worker.ts`)
 * só olhava `conversations` — nunca `agent_cases`. Uma conversa cujo caso já não
 * pede ninguém era reenfileirada a cada despertar da fila e entregue a uma
 * pessoa sem nada a fazer nela.
 *
 * ## A pergunta antes de sortear: "o caso desta conversa pede uma pessoa agora?"
 *
 *   | status            | de quem é a bola        | rotear? |
 *   |-------------------|-------------------------|---------|
 *   | `awaiting_human`  | da equipe               | SIM     |
 *   | `escalated`       | da equipe (foi adiante) | SIM     |
 *   | `awaiting_lead`   | do cliente              | NÃO     |
 *   | `resolved`        | de ninguém              | NÃO     |
 *   | `cancelled`       | de ninguém              | NÃO     |
 *
 * ## O corte temporal
 *
 * Um caso concluído (ou um pedido ao cliente) não cala a fila para sempre: se o
 * cliente falou DEPOIS do marco do caso (`conversations.last_inbound_at` maior
 * que `closed_at` nos terminais, ou que `updated_at` em `awaiting_lead`), o
 * assunto é outro e a fila volta a valer como sempre valeu.
 *
 * ## O que NÃO resolve
 *
 * Caso `awaiting_human` que a IA resolveu sem fechar continua roteável — por
 * definição a pergunta está com a equipe, e não há dado que diga o contrário.
 *
 * Nada aqui olha o relógio do processo: as duas datas vêm do banco. Puro de
 * propósito — quem lê o banco é `lib/routing/worker.ts`.
 */
/** O que o worker precisa saber do caso mais recente da conversa. */
export interface CasoDaConversa {
  status: string;
  /** `agent_cases.closed_at`; só os terminais o preenchem. */
  encerradoEm: string | null;
  /** `agent_cases.updated_at`; para `awaiting_lead`, o instante do pedido ao cliente. */
  atualizadoEm?: string | null;
}

/**
 * Por que o caso tira esta conversa da fila. Os dois valores são também o
 * `reason` do `skip` em `decideRouting` e o que vai para o `metadata` do
 * evento — distinguir `awaiting_lead` de "já concluído" é o que permite
 * responder depois "por que esta conversa não foi distribuída?".
 */
export type MotivoDoCaso = "caso_aguardando_cliente" | "caso_encerrado";

/** A pergunta está com a EQUIPE. */
const PEDE_PESSOA = new Set(["awaiting_human", "escalated"]);
/** A pergunta está com o CLIENTE: um humano já perguntou algo e espera. */
const AGUARDANDO_CLIENTE = new Set(["awaiting_lead"]);
/** Terminais: não é dono de nada. */
const ENCERRADOS = new Set(["resolved", "cancelled"]);

function instante(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * `null` = a fila pode seguir (o caso pede uma pessoa, ou não há caso, ou o
 * status é desconhecido). Um `MotivoDoCaso` = NÃO rotule esta conversa.
 *
 * Status fora do vocabulário conhecido falham ABERTOS (`null`): um clone com
 * engine mais novo pode gravar um estado que este build não conhece, e parar a
 * distribuição de uma org inteira por causa disso é pior do que distribuir uma
 * conversa a mais.
 */
export function motivoParaNaoRotear(
  caso: CasoDaConversa | null | undefined,
  ultimaEntradaDoCliente: string | null | undefined,
): MotivoDoCaso | null {
  if (!caso) return null;
  if (PEDE_PESSOA.has(caso.status)) return null;
  const falouEm = instante(ultimaEntradaDoCliente);
  // Só cala a fila se o cliente NÃO falou depois do marco do caso.
  const falouDepois = (marco: string | null | undefined): boolean => {
    const desde = instante(marco);
    return desde !== null && falouEm !== null && falouEm > desde;
  };
  if (AGUARDANDO_CLIENTE.has(caso.status)) {
    return falouDepois(caso.atualizadoEm) ? null : "caso_aguardando_cliente";
  }
  if (!ENCERRADOS.has(caso.status)) return null;
  return falouDepois(caso.encerradoEm) ? null : "caso_encerrado";
}
