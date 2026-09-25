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

/** Base da Graph API do Instagram. A variável existe para o e2e apontar para um receptor local. */
export function baseDoInstagram(): string {
  return (process.env.INSTAGRAM_GRAPH_BASE_URL ?? "").trim().replace(/\/+$/, "") || BASE_DO_INSTAGRAM;
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
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
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
