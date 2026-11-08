import { SITUACAO_SEGURA_O_LEAD } from "@/lib/agenda/tipos";

import type { Agendamento, SituacaoDoAgendamento } from "./tipos";

/**
 * A FORMA do bloco diz a situação — A2 do pacote 2 de design.
 *
 * A cor do bloco já diz QUEM atende (a trilha), então a situação não pode ser
 * mais uma cor: vira forma (borda tracejada = "ainda não", como em toda a base)
 * e ícone. O nome da situação não vai escrito no bloco — não cabe num bloco de
 * 30 min —, vai no `title` e no `aria-label`, com as palavras de
 * `ROTULO_DA_SITUACAO`.
 *
 * "Confirmado" é o bloco de sempre, sem ícone: é o caso comum, e marcar o caso
 * comum encheria a grade de ícones que não dizem nada.
 */
export type IconeDaSituacao = "relogio" | "realizado" | "falta" | null;

export function formaDaSituacao(situacao: SituacaoDoAgendamento): {
  icone: IconeDaSituacao;
  tracejado: boolean;
  tituloDeApoio: boolean;
} {
  switch (situacao) {
    case "pending":
      return { icone: "relogio", tracejado: true, tituloDeApoio: false };
    case "completed":
      return { icone: "realizado", tracejado: false, tituloDeApoio: true };
    case "no_show":
      return { icone: "falta", tracejado: false, tituloDeApoio: false };
    default:
      // "confirmed", "cancelled" — e valor que o servidor mande fora do
      // vocabulário: o bloco de sempre, nunca um card quebrado.
      return { icone: null, tracejado: false, tituloDeApoio: false };
  }
}

/**
 * Os compromissos NOSSOS que caem em cima de outro item do MESMO profissional.
 *
 * O outro item pode ser um bloqueio de "Dias fora da rotina", um "Ocupado" do
 * Google ou outro compromisso — os três chegam na mesma lista, e os dois
 * primeiros com `origem: "google_sync"`. A grade os desenha lado a lado
 * (`repartirSobrepostos`) e por isso parecia tudo certo: um bloqueio por cima
 * de paciente marcado não avisava ninguém.
 *
 * Só conta o que ainda está DE PÉ (`SITUACAO_SEGURA_O_LEAD`): um "Realizado"
 * sob um bloqueio é história, e pedir para remarcá-lo não faz sentido.
 * Profissionais diferentes no mesmo horário são o caso normal de uma clínica,
 * não conflito. Item sem responsável (Google sem dono resolvido) não acusa
 * ninguém: não há de quem seria o conflito.
 *
 * ponytail: O(n²) por profissional; a grade tem dezenas de itens por semana.
 */
export function conflitosDaGrade(agendamentos: readonly Agendamento[]): Set<string> {
  const vivos = agendamentos.filter((a) => a.responsavelId && SITUACAO_SEGURA_O_LEAD[a.situacao]);
  const conflitos = new Set<string>();
  for (let i = 0; i < vivos.length; i++) {
    const a = vivos[i]!;
    for (let j = i + 1; j < vivos.length; j++) {
      const b = vivos[j]!;
      if (a.responsavelId !== b.responsavelId) continue;
      if (!(new Date(a.comeca) < new Date(b.termina) && new Date(b.comeca) < new Date(a.termina))) continue;
      if (a.origem !== "google_sync") conflitos.add(a.id);
      if (b.origem !== "google_sync") conflitos.add(b.id);
    }
  }
  return conflitos;
}
