import { logger } from "@/lib/logger";

/** Cookie do state/nonce/verificador entre /evalink/entrar e /evalink/volta (route.ts só exporta GET/POST/config). */
export const COOKIE_LOGIN = "evalink_login";

export type ConfigEvalink = {
  contaUrl: string;
  clientId: string;
  clientSecret: string;
  segredoAviso: string;
  orgPadrao: string;
  appUrl: string;
  emissor: string;
  voltaUrl: string;
};

// As rotas chamam configEvalink() a cada requisição: o aviso sai uma vez por processo, não a cada acesso.
let avisou = false;
const avisar = (msg: string) => {
  if (avisou) return;
  avisou = true;
  logger.warn(msg);
};

const semBarra = (u: string) => u.replace(/\/+$/, "");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ehUrl = (u: string) => {
  try {
    return /^https?:$/.test(new URL(u).protocol);
  } catch {
    return false;
  }
};

/**
 * null = EvaLink desligado e o CRM segue exatamente como antes. Nunca lança: variável
 * malformada desliga o EvaLink e avisa no log, em vez de derrubar o CRM inteiro.
 */
export function configEvalink(
  fonte: Record<string, string | undefined> = process.env,
): ConfigEvalink | null {
  const v = (k: string) => fonte[k]?.trim() || undefined;
  const conta = v("CONTA_URL");
  const cid = v("EVALINK_CLIENT_ID");
  const sec = v("EVALINK_CLIENT_SECRET");
  const seg = v("EVALINK_SEGREDO_AVISO");
  const org = v("EVALINK_ORG_PADRAO");
  const app = v("NEXT_PUBLIC_APP_URL");

  if (!conta && !cid && !sec && !seg && !org) return null;

  if (!conta || !cid || !sec || !seg || !org || !app) {
    avisar("evalink: configuração incompleta, login pela Conta desligado");
    return null;
  }

  if (!ehUrl(conta) || !ehUrl(app) || seg.length < 32 || !UUID.test(org)) {
    avisar("evalink: configuração inválida, login pela Conta desligado");
    return null;
  }

  const contaUrl = semBarra(conta);
  const appUrl = semBarra(app);

  return {
    contaUrl,
    clientId: cid,
    clientSecret: sec,
    segredoAviso: seg,
    orgPadrao: org,
    appUrl,
    emissor: `${contaUrl}/auth/v1`,
    voltaUrl: `${appUrl}/evalink/volta`,
  };
}
