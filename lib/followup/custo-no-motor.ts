import type { NodeType } from './graph-schema';

/**
 * O SEGUNDO teto do follow-up: o do MOTOR.
 *
 * Portado do projeto original (DeskcommCRM, PR #2965 de @webtecnica).
 *
 * O validador de publicação tem o teto dele — `MAX_PATH_STEPS` (30 passos "que o
 * cliente sente", ver `validate-publish.ts`). O relógio tem OUTRO: `MAX_STEPS` em
 * `engine.ts` conta TICKS — `steps_taken` sobe a cada passada, tenha o nó chegado
 * ao cliente ou não — e marca a inscrição como morta quando começa um tick com o
 * contador acima do teto. Sem cruzar as duas pontas, um fluxo passaria nos 30
 * passos sentidos e morreria no meio no motor.
 *
 * `CUSTO_NO_MOTOR` é o preço em ticks de cada tipo de nó, lido do próprio motor:
 *  - `trigger`, `condition` e `end` custam 1 — avançam (ou concluem) em um tick;
 *  - `wait` custa 2: um tick arma a espera, outro vence e avança;
 *  - `action` custa 2: o motor ENFILEIRA o turno (`engine.ts`) e a ponte CONCLUI
 *    (`turn-bridge.ts`), cada ponta com o seu `steps_taken + 1`;
 *  - `ai_classify` e `match_reply` custam 2: armam a espera e resolvem depois.
 *
 * `Record<NodeType, number>` exaustivo DE PROPÓSITO: um tipo de nó novo quebra o
 * typecheck até alguém dizer quanto ele custa.
 *
 * O custo é um PISO: rechecks de turno lento também gastam tick, e só somam.
 */
export const CUSTO_NO_MOTOR: Record<NodeType, number> = {
  trigger: 1,
  condition: 1,
  end: 1,
  wait: 2,
  action: 2,
  ai_classify: 2,
  match_reply: 2,
  // `repeat` é CICLO: vale 1 tick por passagem, e é este preço que a publicação
  // multiplica pelas voltas que o `repeat` permite (`custoNoMotorDoFluxo`).
  repeat: 1,
  // Ações sem mensagem (mover no funil, etiqueta): avançam no mesmo tick, como
  // `condition` — a escrita sai junto do `advance`, guardada pelo evento do passo.
  move_lead: 1,
  edit_lead_tag: 1,
};

/**
 * O teto de ticks do motor. É o MESMO número de `MAX_STEPS` em `engine.ts`, que o
 * importa daqui para as duas pontas não poderem divergir.
 */
export const TETO_DE_PASSOS_DO_MOTOR = 80;
