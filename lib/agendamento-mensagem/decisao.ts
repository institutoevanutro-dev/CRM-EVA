/**
 * O que fazer com UMA mensagem agendada vencida, nesta rodada do cron.
 *
 * Pura, para ser testada sem banco. A rota junta os fatos (conexão, janela do
 * número, último envio agendado do número) e grava o desfecho.
 *
 * Três regras que não existiam no original e que a revisão do porte pediu:
 *  - ATRASO TEM TETO: passou de `TETO_DE_ATRASO_MS` do horário marcado, não sai
 *    mais (`expirada`). Um "lembrete das 9h" que chega dois dias depois, de
 *    madrugada, é pior que não chegar.
 *  - ENVIO ATRASADO RESPEITA A JANELA DO NÚMERO (a mesma `channel_knobs` da
 *    campanha e do follow-up) e um RITMO mínimo por número: quando o número
 *    volta depois de horas fora, a fila não sai em rajada.
 *  - Envio no horário (até `FOLGA_DO_HORARIO_MS` de atraso, que é o tique do
 *    cron) segue como antes: o atendente escolheu aquela hora.
 */
export const TETO_DE_ATRASO_MS = 12 * 60 * 60 * 1000;
export const FOLGA_DO_HORARIO_MS = 10 * 60 * 1000;
export const RITMO_DO_NUMERO_MS = 60 * 1000;
export const ESPERA_DO_NUMERO_FORA_MS = 5 * 60 * 1000;

export interface FatosDoAgendamento {
  agora: Date;
  scheduledAt: Date;
  seDesconectado: "esperar" | "cancelar";
  conectado: boolean;
  /** `null` = janela do número aberta agora; senão, quando ela abre. */
  janelaAbreEm: Date | null;
  /** O último envio agendado encaminhado por ESTE número, se houver. */
  ultimoEnvioDoNumero: Date | null;
}

export type Decisao =
  | { acao: "enviar" }
  | { acao: "cancelar"; motivo: "expirada" | "numero_desconectado" }
  | { acao: "adiar"; ate: Date; razao: "numero_desconectado" | "fora_da_janela" | "ritmo" };

export function decidirAgendamento(f: FatosDoAgendamento): Decisao {
  const atraso = f.agora.getTime() - f.scheduledAt.getTime();
  if (atraso > TETO_DE_ATRASO_MS) return { acao: "cancelar", motivo: "expirada" };

  if (!f.conectado) {
    if (f.seDesconectado === "cancelar") return { acao: "cancelar", motivo: "numero_desconectado" };
    return { acao: "adiar", ate: new Date(f.agora.getTime() + ESPERA_DO_NUMERO_FORA_MS), razao: "numero_desconectado" };
  }

  if (atraso > FOLGA_DO_HORARIO_MS) {
    if (f.janelaAbreEm) return { acao: "adiar", ate: f.janelaAbreEm, razao: "fora_da_janela" };
    if (f.ultimoEnvioDoNumero) {
      const livreEm = f.ultimoEnvioDoNumero.getTime() + RITMO_DO_NUMERO_MS;
      if (livreEm > f.agora.getTime()) return { acao: "adiar", ate: new Date(livreEm), razao: "ritmo" };
    }
  }
  return { acao: "enviar" };
}
