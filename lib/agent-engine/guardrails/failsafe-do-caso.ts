/**
 * A RÉGUA DO FAIL-SAFE DE CASO HUMANO (porte do upstream #3816, issue #3725).
 *
 * Quando o `casePromiseGate` veta duas vezes a mesma promessa, o fail-safe do turno
 * (`inbound-turn.ts`) ABRE UM CASO HUMANO: a conversa vai para a fila e o paciente
 * recebe o aviso de passagem. O aviso é uma AFIRMAÇÃO ao paciente, e só é verdade se
 * alguém de fato precisa de uma pessoa.
 *
 * O defeito: o paciente respondeu só "Não" a "tem algum dia ou período melhor?"; a IA
 * respondeu "sem problema, nossa equipe vai te responder outro dia" (promessa de
 * RETOMADA) e o caso humano foi aberto. O paciente leu que foi passado a um atendente
 * sem ter pedido nada.
 *
 * Abre caso quando QUALQUER uma vale (OU):
 *   1. alguma mensagem do PACIENTE na conversa tem sinal de que precisa de gente:
 *      pedido explícito (`detectHumanHandoffRequest`), palavra-chave de passagem do
 *      próprio agente (`matchesHandoffKeyword`), nome de pessoa/retaguarda
 *      ("atendente", "recepção", "doutora"...), pedido de ajuda, reclamação, ou
 *      URGÊNCIA/SINTOMA (`detectUrgencySignal` + vocabulário clínico abaixo);
 *   2. a candidata promete ENVOLVER alguém da equipe (`detectHumanHandoffPromise`,
 *      família da AÇÃO). Só "a equipe vai te responder depois" fica de fora.
 *
 * Conservador de propósito (clínica médica): o item 1 é mais largo que o upstream
 * (urgência, sintoma, reclamação, ajuda). Os dois erros não custam o mesmo: um aviso
 * de passagem a mais incomoda; um paciente com dor ou reclamação que não chega a
 * ninguém é o erro caro. Sem nenhum sinal, o veto continua de pé (a promessa NÃO sai)
 * e o modelo recebe o erro-de-ensino para reformular.
 */
import { detectHumanHandoffRequest } from '../agent/human-handoff';
import { matchesHandoffKeyword } from '../agent/agent-config';

import { detectHumanHandoffPromise } from './human-promise';
import { detectUrgencySignal } from './sinal-de-urgencia';

export interface MensagemDaConversaParaFailsafe {
  direction: string;
  body: string;
}

export interface EntradaDoFailsafeDoCaso {
  /** Mensagens da conversa (episódio atual), na ordem. */
  mensagens: readonly MensagemDaConversaParaFailsafe[];
  /** A candidata a envio que o gate barrou. */
  corpo: string;
  /** `handoff_keywords` do agente: alvo humano próprio e palavras que pedem gente. */
  alvosExtras?: readonly string[];
}

/** Pessoa/retaguarda nomeada pelo paciente (texto já sem acento e minúsculo). */
const SINAL_DE_PESSOA =
  /\b(?:humano|humana|pessoa|pessoas|gente|alguem|ninguem|atendente|atendentes|gerente|supervisor|supervisora|responsavel|setor|departamento|equipe|recepcao|recepcionista|secretaria|doutor|doutora|dr|dra|medico|medica|enfermeir[oa]|biomedic[oa]|nutricionista|dono|dona|procon|advogad[oa])\b/;

/**
 * Pedido de ajuda, de contato por telefone, de mudança na agenda e reclamação: na
 * dúvida, gente. ("pode me ligar?", "preciso remarcar", "não gostei do resultado")
 */
const SINAL_DE_AJUDA_OU_RECLAMACAO =
  /\b(?:ajuda|ajudar|socorro|reclam\w*|absurdo|insatisfeit[oa]|descaso|desrespeito|pessimo|horrivel|nao gostei|cancelar|cancelamento|reembolso|estorno|devolu\w*|ligar|liga|ligue|liguem|ligacao|ligacoes|retorno|retornar|remarc\w*|desmarc\w*)\b/;

/** Sintoma ou intercorrência relatada pelo paciente (complementa o léxico genérico). */
const SINAL_CLINICO =
  /\b(?:dor|doendo|doi|sangr\w*|febre|alergi\w*|reacao|inchad[oa]|inchaco|inflam\w*|infec\w*|pus|vermelhid\w*|hematoma|roxo|queimad\w*|tontura|respirar|passando mal|mal[- ]estar|inchou|inchando|caroco|carocos|secrecao|coceira|cocando|formigamento|formigando|desmai\w*|vomit\w*|falta de ar|intercorrencia|piorou|piorando|emergencia|urgente|urgencia)\b/;

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** True quando a mensagem do PACIENTE pede (ou precisa de) uma pessoa. "Não" não casa. */
export function temSinalDePessoaNaMensagem(
  mensagem: string,
  alvosExtras: readonly string[] = [],
): boolean {
  if (mensagem.trim() === '') return false;
  if (detectHumanHandoffRequest(mensagem) || detectUrgencySignal(mensagem)) return true;
  if (alvosExtras.length > 0 && matchesHandoffKeyword(mensagem, alvosExtras)) return true;
  const texto = normalize(mensagem);
  return (
    SINAL_DE_PESSOA.test(texto) || SINAL_DE_AJUDA_OU_RECLAMACAO.test(texto) || SINAL_CLINICO.test(texto)
  );
}

/** True quando o fail-safe PODE abrir caso humano. */
export function deveAbrirCasoDoFailsafe(entrada: EntradaDoFailsafeDoCaso): boolean {
  const alvos = entrada.alvosExtras ?? [];
  if (
    entrada.mensagens.some(
      (m) => m.direction === 'inbound' && temSinalDePessoaNaMensagem(m.body, alvos),
    )
  ) {
    return true;
  }
  return detectHumanHandoffPromise(entrada.corpo, alvos);
}
