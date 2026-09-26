/**
 * Encanamento cru da Graph API do Instagram (Direct).
 *
 * A URL-base mora aqui — e não em cada adapter — porque ela é conhecimento do
 * PROVIDER, não de quem consulta saúde ou (numa etapa futura) envia mensagem:
 * o `lint:channels` proíbe o host fora de `lib/channels/`, e um segundo
 * chamador que reescrevesse a string à mão divergiria no dia do bump de
 * versão — o mesmo defeito que `lib/graph-version.ts` existe para fechar do
 * lado da versão.
 */
import { graphVersion } from "@/lib/graph-version";
import { logger } from "@/lib/logger";

export const BASE_DO_INSTAGRAM = "https://graph.instagram.com";

/** `localhost`, `127.x.x.x` ou `[::1]` — o receptor do e2e, e nada que saia da máquina. */
const HOST_DE_LOOPBACK_RX = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i;

function apontaParaLoopback(url: string): boolean {
  try {
    return HOST_DE_LOOPBACK_RX.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Base da Graph API do Instagram. A variável existe para o e2e apontar para um
 * receptor local — e é só para isso que ela vale em produção: todo chamador
 * manda `Authorization: Bearer <token da conta do cliente>` para esta base, e
 * um `.env` de teste copiado para a VPS entregaria o token ao host que a
 * variável apontar. Em `NODE_ENV=production` só loopback é honrado (o e2e roda
 * sob `next start`, que É produção); qualquer outro host cai na base da Meta.
 *
 * O env entra por parâmetro (como `metaPodeReceber` em `../meta/webhook.ts`):
 * `NodeJS.ProcessEnv` exige `NODE_ENV` e obrigaria todo teste a montá-lo.
 */
export function baseDoInstagram(env: Record<string, string | undefined> = process.env): string {
  const valor = (env.INSTAGRAM_GRAPH_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!valor) return BASE_DO_INSTAGRAM;
  if (env.NODE_ENV === "production" && !apontaParaLoopback(valor)) return BASE_DO_INSTAGRAM;
  return valor;
}

/**
 * Nome, handle e foto de quem mandou a mensagem (IGSID). Best-effort: qualquer
 * falha (rede, token vencido, campo ausente) devolve os três `null` — a
 * ingestão segue sem perfil, nunca quebra por causa dele.
 */
export async function perfilDoRemetente(
  token: string,
  igsid: string,
): Promise<{ nome: string | null; handle: string | null; foto: string | null }> {
  const url = `${baseDoInstagram()}/${graphVersion()}/${encodeURIComponent(igsid)}?fields=name,username,profile_pic`;
  try {
    // Teto de espera: o estouro cai no catch e a ingestão segue sem perfil.
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      logger.info("[instagram.graph] perfil indisponível", { status: res.status });
      return { nome: null, handle: null, foto: null };
    }
    const j = (await res.json()) as { name?: string; username?: string; profile_pic?: string };
    return { nome: j.name ?? null, handle: j.username ?? null, foto: j.profile_pic ?? null };
  } catch (err) {
    logger.info("[instagram.graph] perfil falhou", { error: err instanceof Error ? err.message : String(err) });
    return { nome: null, handle: null, foto: null };
  }
}
