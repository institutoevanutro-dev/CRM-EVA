/**
 * A conexão diz `WORKING` e não entrega mensagem: conectada, mas surda.
 *
 * ─── O defeito, medido (10/10/2026) ─────────────────────────────────────────
 *
 * A sessão do WhatsApp perde o websocket algumas vezes por dia e volta sozinha
 * em uns 2 segundos (WORKING → STARTING → WORKING). De vez em quando ela volta
 * dizendo `WORKING` e para de entregar o que chega. Nenhum aviso existente
 * pega isso: o vigia de saúde pergunta o ESTADO, e o estado está certo. Um
 * reinício suave (stop + start, sem logout, sem QR) resolveu em 20 segundos.
 *
 * ─── A regra ────────────────────────────────────────────────────────────────
 *
 * Suspeita só existe DEPOIS de uma queda: o relógio começa em
 * `last_status_change_at`. Sem isso, toda madrugada sem cliente viraria
 * "surdez". E cada queda rende no máximo UM reinício automático: a marca
 * `metadata.vigia_surdez.reiniciado_em` trava o laço enquanto nenhuma mudança
 * de estado NOVA aparecer depois dele.
 *
 * Este arquivo é só a decisão, pura. Quem consulta o banco, fala com o
 * transporte e abre o aviso é `app/api/v1/cron/channel-health/route.ts`.
 */
import { STATUS_SAUDAVEL } from "./health";

/** Silêncio mínimo depois da queda para suspeitar. Menos que isso é hora calma. */
export const SURDEZ_SILENCIO_MINIMO_MS = 45 * 60_000;
/** Depois disto o silêncio já não aponta para a queda (noite, fim de semana). */
export const SURDEZ_JANELA_MAXIMA_MS = 6 * 60 * 60_000;
/** Mudança de estado até aqui depois do nosso reinício é efeito DELE, não queda nova. */
export const SURDEZ_FOLGA_DO_REINICIO_MS = 5 * 60_000;
/**
 * O aviso só sai depois que os eventos do reinício assentaram. O stop do
 * reinício pode chegar como `STOPPED` pelo webhook, e a volta a `WORKING` faz
 * `sincronizarSaudeDaConexao` fechar TODO aviso aberto desta sessão. Aberto na
 * hora, o nosso seria fechado segundos depois, sem ninguém ter lido.
 */
export const SURDEZ_ESPERA_DO_AVISO_MS = 2 * 60_000;

/** Chave em `channel_sessions.metadata`. */
export const CHAVE_DO_VIGIA = "vigia_surdez";

export interface MarcaDoVigia {
  reiniciado_em: string;
  /** O transporte recusou o reinício. Muda só o texto do aviso. */
  falhou?: boolean;
  avisado_em?: string;
}

export type DecisaoDeSurdez =
  | { acao: "reiniciar" }
  | {
      acao: "nada";
      motivo: "nao_working" | "sem_data" | "reinicio_proprio" | "recente" | "antiga" | "saudavel";
    };

/** A marca gravada, ou `null`. Metadata torta nunca lança nem trava o vigia. */
export function lerMarcaDoVigia(metadata: unknown): MarcaDoVigia | null {
  if (!metadata || typeof metadata !== "object") return null;
  const marca = (metadata as Record<string, unknown>)[CHAVE_DO_VIGIA];
  if (!marca || typeof marca !== "object") return null;
  const { reiniciado_em } = marca as Partial<MarcaDoVigia>;
  if (typeof reiniciado_em !== "string" || Number.isNaN(Date.parse(reiniciado_em))) return null;
  return marca as MarcaDoVigia;
}

export function decidirVigiaDeSurdez(entrada: {
  status: string | null;
  lastStatusChangeAt: string | null;
  metadata: unknown;
  houveEntradaDesdeAMudanca: boolean;
  agora: Date;
}): DecisaoDeSurdez {
  if ((entrada.status ?? "").toUpperCase() !== STATUS_SAUDAVEL) return { acao: "nada", motivo: "nao_working" };

  const mudouEm = entrada.lastStatusChangeAt ? Date.parse(entrada.lastStatusChangeAt) : NaN;
  if (Number.isNaN(mudouEm)) return { acao: "nada", motivo: "sem_data" };

  // `<=` e não "entre": cobre também o reinício que FALHOU e nem moveu a data.
  // Só uma mudança de estado mais nova que a folga rearma o vigia.
  const marca = lerMarcaDoVigia(entrada.metadata);
  if (marca && mudouEm <= Date.parse(marca.reiniciado_em) + SURDEZ_FOLGA_DO_REINICIO_MS) {
    return { acao: "nada", motivo: "reinicio_proprio" };
  }

  const silencio = entrada.agora.getTime() - mudouEm;
  if (silencio < SURDEZ_SILENCIO_MINIMO_MS) return { acao: "nada", motivo: "recente" };
  if (silencio > SURDEZ_JANELA_MAXIMA_MS) return { acao: "nada", motivo: "antiga" };
  if (entrada.houveEntradaDesdeAMudanca) return { acao: "nada", motivo: "saudavel" };
  return { acao: "reiniciar" };
}

/** Há reinício que ainda não virou aviso na Central, e já deu tempo de assentar? */
export function avisoPendenteDoVigia(metadata: unknown, agora: Date): boolean {
  const marca = lerMarcaDoVigia(metadata);
  if (!marca || marca.avisado_em) return false;
  return agora.getTime() - Date.parse(marca.reiniciado_em) >= SURDEZ_ESPERA_DO_AVISO_MS;
}

export function avisoDeSurdez(apelido: string, falhou: boolean): { title: string; body: string } {
  return {
    title: `WhatsApp "${apelido}" ficou sem receber mensagens depois de uma queda`,
    body: falhou
      ? "A conexão caiu, voltou sozinha e desde então nenhuma mensagem chegou. O CRM tentou reiniciar a conexão e não conseguiu. Vá em Conexões e reconecte."
      : "A conexão caiu, voltou sozinha e desde então nenhuma mensagem chegou. O CRM reiniciou a conexão automaticamente. Se as mensagens continuarem sem chegar, vá em Conexões e reconecte.",
  };
}
