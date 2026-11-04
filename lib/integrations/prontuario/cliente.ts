/**
 * Cliente do envio de exame ao Prontuário (Exames do WhatsApp → Prontuário).
 *
 * Configuração em TRÊS estados, a partir de `PRONTUARIO_URL`,
 * `PRONTUARIO_EXAMES_SEGREDO` e `PRONTUARIO_ORGANIZATION_ID`:
 *   - `desligada`: as três vazias, outra organização, ou org que não é UUID —
 *     nada aparece na tela;
 *   - `invalida`: a organização confere, mas o segredo é curto ou a URL não é
 *     origem https pura — o botão aparece e o clique diz "avise o
 *     administrador", com log e linha de falha na auditoria;
 *   - `ligada`.
 *
 * O envio repete UMA vez, com a mesma `Idempotency-Key` e o mesmo corpo, em
 * rede, estouro de 20 s, 502, 504 e 503 passageiro; nunca nos 503 de
 * configuração. A resposta é lida com teto (16 KiB) e decidida pelo `code`,
 * nunca pelo texto. Nada aqui lança: o desfecho é tipado.
 *
 * Nunca vai a log: segredo, URL, corpo, nome de quem enviou.
 */
import { z } from "zod";

import { BodyLimitError, readLimitedBody } from "@/lib/http/limited-body";
import { logger } from "@/lib/logger";

export type EstadoDosExames =
  | { estado: "desligada" }
  | { estado: "invalida"; motivo: "segredo_curto" | "url_invalida" }
  | { estado: "ligada"; url: string; segredo: string };

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;

export function estadoDosExames(org: string, env: Record<string, string | undefined> = process.env): EstadoDosExames {
  const url = (env.PRONTUARIO_URL ?? "").trim();
  const segredo = (env.PRONTUARIO_EXAMES_SEGREDO ?? "").trim();
  const dono = (env.PRONTUARIO_ORGANIZATION_ID ?? "").trim();
  if (!url && !segredo && !dono) return { estado: "desligada" };
  if (!z.uuid().safeParse(org).success || dono.toLowerCase() !== org.toLowerCase()) return { estado: "desligada" };
  if (segredo.length < 32) return { estado: "invalida", motivo: "segredo_curto" };
  try {
    const u = new URL(url);
    const protocoloOk = u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.test(u.hostname));
    if (!protocoloOk || u.username || u.password || u.search || u.hash || u.pathname !== "/")
      return { estado: "invalida", motivo: "url_invalida" };
    return { estado: "ligada", url: u.origin, segredo };
  } catch {
    return { estado: "invalida", motivo: "url_invalida" };
  }
}

/**
 * O código que o Prontuário devolve (409) quando o vínculo do contato ainda
 * não foi confirmado lá. Nome combinado em 04/11 como provável: trocar AQUI.
 */
export const CODIGO_DO_PRONTUARIO_VINCULO_NAO_CONFIRMADO = "vinculo_nao_confirmado";

/** Os 503 de configuração do Prontuário: repetir não adianta. */
const SEM_NOVA_TENTATIVA_503 = new Set(["integracao_desligada", "crm_nao_configurado", "crm_recusou_chave"]);

export type CodigoDoEnvio =
  | "paciente_nao_vinculado"
  | "vinculo_nao_confirmado"
  | "contato_com_varios_pacientes"
  | "midia_nao_encontrada"
  | "midia_ainda_nao_disponivel"
  | "formato_nao_aceito"
  | "grande_demais"
  | "prontuario_configuracao"
  | "prontuario_indisponivel"
  | "prontuario_sem_acesso_ao_crm";

export type DesfechoDoEnvio =
  | { ok: true; examId: string; jaExistia: boolean; tentativas: number }
  | {
      ok: false;
      codigo: CodigoDoEnvio;
      /** `null` quando não houve resposta (rede ou estouro). */
      statusDoProntuario: number | null;
      codigoDoProntuario: string | null;
      tentativas: number;
    };

export type CorpoDoEnvio = { contact_id: string; message_id: string; enviado_por: string };

const sucessoSchema = z.object({ exam_id: z.uuid(), ja_existia: z.boolean() });

const POR_TENTATIVA_MS = 20_000;
const PRAZO_TOTAL_MS = 40_000;
const TETO_DA_RESPOSTA = 16 * 1024;

type Tentativa =
  | { tipo: "sem_resposta" }
  | { tipo: "resposta"; status: number; json: unknown; corpoInvalido: boolean };

function codigoDe(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const e = (json as { error?: unknown }).error;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string") return (e as { code: string }).code;
  return null;
}

async function tentar(cfg: { url: string; segredo: string }, corpo: CorpoDoEnvio, ms: number, f: typeof fetch): Promise<Tentativa> {
  try {
    const res = await f(`${cfg.url}/api/integracoes/crm/exames`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.segredo}`,
        "Content-Type": "application/json",
        "Idempotency-Key": corpo.message_id,
      },
      body: JSON.stringify(corpo),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(ms),
    });
    try {
      const bytes = await readLimitedBody(res, TETO_DA_RESPOSTA, ms);
      let json: unknown = null;
      try {
        json = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        json = null;
      }
      return { tipo: "resposta", status: res.status, json, corpoInvalido: false };
    } catch (e) {
      if (e instanceof BodyLimitError && e.status === 413) return { tipo: "resposta", status: res.status, json: null, corpoInvalido: true };
      return { tipo: "sem_resposta" };
    }
  } catch {
    return { tipo: "sem_resposta" };
  }
}

function repete(t: Tentativa): boolean {
  if (t.tipo === "sem_resposta") return true;
  if (t.corpoInvalido) return false;
  if (t.status === 502 || t.status === 504) return true;
  if (t.status === 503) return !SEM_NOVA_TENTATIVA_503.has(codigoDe(t.json) ?? "");
  return false;
}

function traduzir(t: Tentativa): CodigoDoEnvio {
  if (t.tipo === "sem_resposta" || t.corpoInvalido) return "prontuario_indisponivel";
  const c = codigoDe(t.json);
  switch (t.status) {
    case 404:
      if (c === "paciente_nao_vinculado") return "paciente_nao_vinculado";
      if (c === "midia_nao_encontrada") return "midia_nao_encontrada";
      return "prontuario_configuracao";
    case 409:
      if (c === "contato_com_varios_pacientes") return "contato_com_varios_pacientes";
      if (c === "midia_ainda_nao_disponivel") return "midia_ainda_nao_disponivel";
      if (c === CODIGO_DO_PRONTUARIO_VINCULO_NAO_CONFIRMADO) return "vinculo_nao_confirmado";
      return "prontuario_indisponivel";
    case 422:
      return c === "formato_nao_aceito" ? "formato_nao_aceito" : "prontuario_indisponivel";
    case 413:
      return c === "grande_demais" ? "grande_demais" : "prontuario_configuracao";
    case 400:
    case 401:
      return "prontuario_configuracao";
    case 503:
      if (SEM_NOVA_TENTATIVA_503.has(c ?? "")) return "prontuario_configuracao";
      if (c === "crm_indisponivel") return "prontuario_sem_acesso_ao_crm";
      return "prontuario_indisponivel";
    default:
      return "prontuario_indisponivel";
  }
}

export async function enviarExameAoProntuario(
  cfg: { url: string; segredo: string },
  corpo: CorpoDoEnvio,
  opts: { requestId?: string; fetch?: typeof fetch; agora?: () => number } = {},
): Promise<DesfechoDoEnvio> {
  const f = opts.fetch ?? fetch;
  const agora = opts.agora ?? Date.now;
  const inicio = agora();
  let tentativas = 0;
  let ultima: Tentativa = { tipo: "sem_resposta" };
  // A 1ª pode ter gravado no Prontuário se não houve resposta, ou se veio 502/504.
  let primeiraPodeTerGravado = false;

  while (tentativas < 2) {
    const restante = PRAZO_TOTAL_MS - (agora() - inicio);
    if (tentativas > 0 && restante < 1_000) break;
    tentativas++;
    ultima = await tentar(cfg, corpo, Math.min(POR_TENTATIVA_MS, restante), f);

    if (ultima.tipo === "resposta" && !ultima.corpoInvalido && ultima.status >= 200 && ultima.status < 300) {
      const ok = sucessoSchema.safeParse(ultima.json);
      if (ok.success) {
        const jaExistia = ok.data.ja_existia && !(tentativas === 2 && primeiraPodeTerGravado);
        return { ok: true, examId: ok.data.exam_id, jaExistia, tentativas };
      }
      ultima = { ...ultima, corpoInvalido: true };
      break;
    }
    if (!repete(ultima)) break;
    if (tentativas === 1)
      primeiraPodeTerGravado = ultima.tipo === "sem_resposta" || ultima.status === 502 || ultima.status === 504;
  }

  const codigo = traduzir(ultima);
  const status = ultima.tipo === "resposta" ? ultima.status : null;
  const codigoDoProntuario = ultima.tipo === "resposta" ? codigoDe(ultima.json) : null;
  const grave = codigo === "prontuario_configuracao" || codigo === "prontuario_sem_acesso_ao_crm" ||
    (ultima.tipo === "resposta" && (ultima.corpoInvalido || ![404, 409, 413, 422, 429, 502, 503, 504].includes(ultima.status)));
  (grave ? logger.error : logger.warn)("prontuario.exames.envio", {
    codigo,
    status,
    tentativa: tentativas,
    request_id: opts.requestId,
    message_id: corpo.message_id,
  });
  return { ok: false, codigo, statusDoProntuario: status, codigoDoProntuario, tentativas };
}
