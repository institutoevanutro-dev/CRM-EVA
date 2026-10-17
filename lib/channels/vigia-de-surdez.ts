/**
 * A conexão diz `WORKING` e não entrega mensagem: conectada, mas surda.
 *
 * ─── O defeito, medido (10/10/2026) ─────────────────────────────────────────
 *
 * A sessão do WhatsApp perde o websocket algumas vezes por dia e volta sozinha
 * em uns 2 segundos (WORKING → STARTING → WORKING). De vez em quando ela volta
 * dizendo `WORKING` e para de entregar o que chega. Nenhum aviso existente
 * pega isso: o vigia de saúde pergunta o ESTADO, e o estado está certo. Um
 * reinício suave (sem logout, sem QR) resolveu em 20 segundos.
 *
 * ─── E o que a primeira versão deixou passar (outubro/2026) ─────────────────
 *
 * O número oscilou a madrugada inteira e amanheceu surdo. O vigia reiniciou UMA
 * vez, abriu o aviso na Central às 09:45 e parou ali: a regra era "uma tentativa
 * por queda". O reinício não resolveu (falhou no meio ou rodou sem efeito; só
 * o sucesso era auditado), ninguém abriu a Central, e o número ficou ~15 h sem
 * receber. Um reinício feito à mão curou na hora, sem QR, e o que os
 * pacientes mandaram no intervalo não voltou.
 *
 * Daí as três peças novas: o vigia CONFERE se o reinício adiantou e tenta de
 * novo, até um teto; quando desiste, chama gente com um aviso próprio; e quando
 * as mensagens voltam, diz a janela em que mensagem pode ter se perdido. Todo
 * aviso do vigia vai também ao celular (`lib/notifications/push-dos-avisos.ts`).
 *
 * ─── A regra ────────────────────────────────────────────────────────────────
 *
 * Suspeita só existe DEPOIS de uma queda: o relógio começa em
 * `last_status_change_at`. Sem isso, toda madrugada sem cliente viraria
 * "surdez". Uma mudança de estado até 5 min depois do nosso reinício é efeito
 * DELE, e o episódio continua o mesmo; só uma mudança mais nova abre outro.
 *
 * Dentro do episódio: reinicia com 45 min de silêncio, confere, e reinicia de
 * novo com mais 45 min de silêncio desde o último reinício, enquanto a queda
 * tiver menos de 6 h e o TETO deixar (padrão: 2 reinícios por sessão a cada
 * 6 h, contados entre episódios: o número que cai toda hora não vira laço).
 * Sem poder tentar de novo, escala uma vez. Entrou mensagem: "voltou", uma vez.
 *
 * Este arquivo é só a decisão e o texto, puros. Quem consulta o banco, fala com
 * o transporte e abre o aviso é `app/api/v1/cron/channel-health/route.ts`.
 */
import { tagDeIdioma } from "@/lib/i18n/datas";
import type { Idioma } from "@/lib/i18n/idiomas";

import { STATUS_SAUDAVEL } from "./health";

/** Silêncio mínimo depois da queda (ou do último reinício) para suspeitar. */
export const SURDEZ_SILENCIO_MINIMO_MS = 45 * 60_000;
/** Depois disto o silêncio já não aponta para a queda (noite, fim de semana). */
export const SURDEZ_JANELA_MAXIMA_MS = 6 * 60 * 60_000;
/** Mudança de estado até aqui depois do nosso reinício é efeito DELE, não queda nova. */
export const SURDEZ_FOLGA_DO_REINICIO_MS = 5 * 60_000;
/**
 * O aviso do reinício só sai depois que os eventos dele assentaram. O stop do
 * reinício pode chegar como `STOPPED` pelo webhook, e a volta a `WORKING` faz
 * `sincronizarSaudeDaConexao` fechar TODO aviso aberto desta sessão. Aberto na
 * hora, o nosso seria fechado segundos depois, sem ninguém ter lido.
 */
export const SURDEZ_ESPERA_DO_AVISO_MS = 2 * 60_000;

/** Chave em `channel_sessions.metadata`. */
export const CHAVE_DO_VIGIA = "vigia_surdez";

export interface TetoDeReinicios {
  maximo: number;
  janelaMs: number;
}
const HORA_MS = 60 * 60_000;
export const TETO_PADRAO: TetoDeReinicios = { maximo: 2, janelaMs: 6 * HORA_MS };

/**
 * O teto lido do `.env` (`CHANNEL_DEAF_RESTART_MAX`, `..._WINDOW_HOURS`).
 * Vazio ou lixo vira o padrão: um knob mal digitado não derruba o app nem
 * desliga o vigia em silêncio. `0` reinícios é o único jeito de desligar o
 * reinício automático, e aí o vigia só avisa.
 */
export function tetoDosReinicios(maximo: string | undefined, horas: string | undefined): TetoDeReinicios {
  const inteiro = (bruto: string | undefined, min: number, max: number): number | null => {
    const t = (bruto ?? "").trim();
    if (!/^\d+$/.test(t)) return null;
    const n = Number(t);
    return n >= min && n <= max ? n : null;
  };
  const h = inteiro(horas, 1, 48);
  return {
    maximo: inteiro(maximo, 0, 10) ?? TETO_PADRAO.maximo,
    janelaMs: h === null ? TETO_PADRAO.janelaMs : h * HORA_MS,
  };
}

/** O que o vigia guarda em `metadata.vigia_surdez`. Todo campo é opcional: metadata é texto livre. */
export interface MarcaDoVigia {
  /**
   * Sobe a cada gravação. É a FICHA da trava: a gravação só vale se ninguém
   * gravou depois da leitura, o que impede duas rodadas simultâneas de
   * reiniciarem a mesma sessão duas vezes.
   */
  versao?: number;
  /** O último reinício automático. */
  reiniciado_em?: string;
  /** Os reinícios dentro da janela do teto. Marca antiga, sem a lista, conta só `reiniciado_em`. */
  reinicios?: string[];
  /** O transporte recusou o último reinício. Muda só o texto do aviso. */
  falhou?: boolean;
  /** O aviso do último reinício já saiu. */
  avisado_em?: string;
  /** A queda que abriu o episódio da marca. */
  queda_em?: string;
  /** Como o episódio terminou: voltou a receber, ou o CRM desistiu e chamou gente. */
  desfecho?: "voltou" | "escalado";
  desfecho_em?: string;
}

/** A marca gravada, ou `null`. Metadata torta nunca lança nem trava o vigia. */
export function lerMarcaDoVigia(metadata: unknown): MarcaDoVigia | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const marca = (metadata as Record<string, unknown>)[CHAVE_DO_VIGIA];
  if (!marca || typeof marca !== "object" || Array.isArray(marca)) return null;
  return marca as MarcaDoVigia;
}

/** Instante em ms, ou NaN. Toda comparação com NaN é falsa, e é isso que se quer. */
function instante(v: unknown): number {
  return typeof v === "string" ? Date.parse(v) : NaN;
}

/** Os reinícios registrados, válidos, em ms. */
export function reiniciosDaMarca(marca: MarcaDoVigia | null): number[] {
  if (!marca) return [];
  const lista = Array.isArray(marca.reinicios) ? marca.reinicios : [marca.reiniciado_em];
  return lista.map(instante).filter((t) => !Number.isNaN(t));
}

interface Episodio {
  /** A marca fala desta queda (a última mudança foi o nosso reinício, ou a queda que já tratamos). */
  daMarca: boolean;
  quedaEm: number;
  /** Desde quando se conta o silêncio: a queda, ou o último reinício quando ele é mais novo. */
  relogio: number;
  tentativas: number;
  desfecho: MarcaDoVigia["desfecho"];
}

function episodio(mudouEm: number, marca: MarcaDoVigia | null): Episodio {
  const reiniciadoEm = instante(marca?.reiniciado_em);
  const quedaDaMarca = instante(marca?.queda_em);
  const daMarca = marca !== null && (mudouEm <= reiniciadoEm + SURDEZ_FOLGA_DO_REINICIO_MS || quedaDaMarca === mudouEm);
  if (!daMarca) return { daMarca, quedaEm: mudouEm, relogio: mudouEm, tentativas: 0, desfecho: undefined };
  const quedaEm = Number.isNaN(quedaDaMarca) ? Math.min(mudouEm, reiniciadoEm) : quedaDaMarca;
  return {
    daMarca,
    quedaEm,
    relogio: Number.isNaN(reiniciadoEm) ? mudouEm : Math.max(mudouEm, reiniciadoEm),
    tentativas: reiniciosDaMarca(marca).filter((t) => t >= quedaEm).length,
    desfecho: marca?.desfecho,
  };
}

export type DecisaoDeSurdez =
  | { acao: "reiniciar"; quedaEm: string; tentativa: number }
  | { acao: "voltou"; quedaEm: string }
  /** Não pode mais tentar (teto, janela, ou reinício desligado): chama gente, uma vez por episódio. */
  | { acao: "escalar"; quedaEm: string; tentativas: number; recentes: number }
  | {
      acao: "nada";
      motivo:
        | "nao_working"
        | "sem_data"
        | "recente"
        | "aguardando"
        | "saudavel"
        | "antiga"
        | "escalado"
        | "encerrado";
    };

export interface EntradaDoVigia {
  status: string | null;
  lastStatusChangeAt: string | null;
  metadata: unknown;
  /** Entrou mensagem desde `relogioDoVigia(...)`? */
  houveEntrada: boolean;
  agora: Date;
  teto: TetoDeReinicios;
}

/** Desde quando a rota pergunta se entrou mensagem. `null` sem data de mudança. */
export function relogioDoVigia(lastStatusChangeAt: string | null, metadata: unknown): string | null {
  const mudouEm = instante(lastStatusChangeAt);
  if (Number.isNaN(mudouEm)) return null;
  return new Date(episodio(mudouEm, lerMarcaDoVigia(metadata)).relogio).toISOString();
}

export function decidirVigiaDeSurdez(e: EntradaDoVigia): DecisaoDeSurdez {
  if ((e.status ?? "").toUpperCase() !== STATUS_SAUDAVEL) return { acao: "nada", motivo: "nao_working" };

  const mudouEm = instante(e.lastStatusChangeAt);
  if (Number.isNaN(mudouEm)) return { acao: "nada", motivo: "sem_data" };

  const marca = lerMarcaDoVigia(e.metadata);
  const ep = episodio(mudouEm, marca);
  const agora = e.agora.getTime();
  const quedaEm = new Date(ep.quedaEm).toISOString();

  if (ep.daMarca && ep.desfecho === "voltou") return { acao: "nada", motivo: "encerrado" };
  if (ep.daMarca && e.houveEntrada) return { acao: "voltou", quedaEm };
  if (agora - ep.relogio < SURDEZ_SILENCIO_MINIMO_MS) {
    return { acao: "nada", motivo: ep.daMarca ? "aguardando" : "recente" };
  }
  if (e.houveEntrada) return { acao: "nada", motivo: "saudavel" };
  if (ep.daMarca && ep.desfecho === "escalado") return { acao: "nada", motivo: "escalado" };

  const recentes = reiniciosDaMarca(marca).filter((t) => agora - t < e.teto.janelaMs).length;
  const naJanela = agora - ep.quedaEm <= SURDEZ_JANELA_MAXIMA_MS;
  if (naJanela && recentes < e.teto.maximo) return { acao: "reiniciar", quedaEm, tentativa: ep.tentativas + 1 };
  // Já tentamos nesta queda e não voltou, ou nem podemos tentar com ela fresca: chama gente.
  if (ep.daMarca || naJanela) return { acao: "escalar", quedaEm, tentativas: ep.tentativas, recentes };
  return { acao: "nada", motivo: "antiga" };
}

/**
 * A rota só paga a consulta de mensagens quando ela muda a decisão: antes de
 * agir, e enquanto espera o desfecho de um reinício ou de um aviso. Na rodada
 * comum (sessão saudável, fora da janela) o vigia não toca no banco.
 */
export function precisaPerguntarSeEntrou(d: DecisaoDeSurdez): boolean {
  return d.acao !== "nada" || d.motivo === "aguardando" || d.motivo === "escalado";
}

/** Há reinício que ainda não virou aviso na Central, e já deu tempo de assentar? */
export function avisoPendenteDoVigia(metadata: unknown, agora: Date): boolean {
  const marca = lerMarcaDoVigia(metadata);
  const reiniciadoEm = instante(marca?.reiniciado_em);
  if (!marca || Number.isNaN(reiniciadoEm) || marca.avisado_em) return false;
  return agora.getTime() - reiniciadoEm >= SURDEZ_ESPERA_DO_AVISO_MS;
}

// ─── O texto ─────────────────────────────────────────────────────────────────
//
// O começo do corpo é o que cabe no celular (o push corta em 140 caracteres),
// então cada aviso abre com o que aconteceu ou com o que fazer.

/** Onde e em que idioma a hora do aviso é escrita: os da ORGANIZAÇÃO, porque ninguém está logado. */
export interface RelogioDoAviso {
  fuso: string;
  idioma: Idioma;
  agora: Date;
}

/** "09:40", ou "09/10 23:10" quando não é hoje no fuso da organização. */
function horario(iso: string, r: RelogioDoAviso): string {
  const tag = tagDeIdioma(r.idioma);
  const dia = (x: Date) => new Intl.DateTimeFormat(tag, { timeZone: r.fuso, day: "2-digit", month: "2-digit" }).format(x);
  const d = new Date(iso);
  const hora = new Intl.DateTimeFormat(tag, { timeZone: r.fuso, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return dia(d) === dia(r.agora) ? hora : `${dia(d)} ${hora}`;
}
/** "às 09:40", ou "em 09/10 às 23:10". */
function quando(iso: string, r: RelogioDoAviso): string {
  const h = horario(iso, r);
  return h.includes("/") ? `em ${h.replace(" ", " às ")}` : `às ${h}`;
}
const reinicios = (n: number) => (n === 1 ? "1 reinício automático" : `${n} reinícios automáticos`);

const TITULO_DO_REINICIO = '" ficou sem receber mensagens depois de uma queda';
const TITULO_DA_VOLTA = '" voltou a receber mensagens';
const TITULO_SEM_EFEITO = '" continua sem receber mensagens';

/** O título é de um aviso do vigia? É por ele que o celular reconhece o aviso. */
export function ehAvisoDoVigiaDeSurdez(titulo: string | null | undefined): boolean {
  if (!titulo?.startsWith('WhatsApp "')) return false;
  return [TITULO_DO_REINICIO, TITULO_DA_VOLTA, TITULO_SEM_EFEITO].some((fim) => titulo.endsWith(fim));
}

export function avisoDeSurdez(a: {
  apelido: string;
  falhou: boolean;
  reiniciadoEm: string;
  quedaEm: string;
  tentativa: number;
  maximo: number;
  relogio: RelogioDoAviso;
}): { title: string; body: string } {
  const reinicio = quando(a.reiniciadoEm, a.relogio);
  const queda = quando(a.quedaEm, a.relogio);
  return {
    title: `WhatsApp "${a.apelido}${TITULO_DO_REINICIO}`,
    body: a.falhou
      ? `O CRM tentou reiniciar a conexão sozinho ${reinicio} e não conseguiu. Nenhuma mensagem chegou desde a queda, ${queda}. Vá em Conexões e reconecte.`
      : `O CRM reiniciou a conexão sozinho ${reinicio}, sem deslogar o número. Nenhuma mensagem tinha chegado desde a queda, ${queda}. Tentativa ${a.tentativa} de ${a.maximo}: você recebe outro aviso quando as mensagens voltarem, ou se for preciso reconectar.`,
  };
}

export function avisoDeVoltaDaSurdez(a: {
  apelido: string;
  quedaEm: string;
  reiniciadoEm: string | null;
  voltouEm: string;
  relogio: RelogioDoAviso;
}): { title: string; body: string } {
  const fim = horario(a.reiniciadoEm ?? a.voltouEm, a.relogio);
  return {
    title: `WhatsApp "${a.apelido}${TITULO_DA_VOLTA}`,
    body: `Voltou ${quando(a.voltouEm, a.relogio)}. O que os clientes mandaram entre ${horario(a.quedaEm, a.relogio)} e ${fim} pode não ter entrado no CRM: confira essas conversas no celular e responda quem ficou esperando.`,
  };
}

export function avisoDeSurdezSemEfeito(a: {
  apelido: string;
  quedaEm: string;
  reiniciadoEm: string | null;
  tentativas: number;
  recentes: number;
  teto: TetoDeReinicios;
  relogio: RelogioDoAviso;
}): { title: string; body: string } {
  const queda = quando(a.quedaEm, a.relogio);
  const porque =
    a.tentativas > 0 && a.reiniciadoEm
      ? `Nada chegou desde a queda, ${queda}, nem depois de ${reinicios(a.tentativas)} (o último ${quando(a.reiniciadoEm, a.relogio)}).`
      : a.teto.maximo === 0
        ? `Nada chegou desde a queda, ${queda}, e o reinício automático está desligado nesta instalação.`
        : `Nada chegou desde a queda, ${queda}, e o CRM não reiniciou desta vez porque já fez ${reinicios(a.recentes)} nas últimas ${Math.round(a.teto.janelaMs / HORA_MS)} h.`;
  return {
    title: `WhatsApp "${a.apelido}${TITULO_SEM_EFEITO}`,
    body: `Se alguém mandou mensagem e ela não apareceu no CRM, reconecte em Conexões: pode ser preciso ler o QR de novo no celular. ${porque} Se for só falta de movimento, pode fechar este aviso.`,
  };
}
