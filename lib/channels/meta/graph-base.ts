/**
 * Base da Graph API da Meta (WhatsApp). Cópia declarada de `baseDoInstagram`
 * (`lib/channels/instagram/graph.ts`): a variável existe para o e2e apontar para
 * um receptor local, e em produção só loopback é honrado — todo chamador manda
 * `Authorization: Bearer <token do cliente>` para esta base.
 */
export const BASE_DA_GRAPH = "https://graph.facebook.com";

const HOST_DE_LOOPBACK_RX = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i;

function apontaParaLoopback(url: string): boolean {
  try {
    return HOST_DE_LOOPBACK_RX.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function baseDaGraph(env: Record<string, string | undefined> = process.env): string {
  const valor = (env.META_GRAPH_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!valor) return BASE_DA_GRAPH;
  if (env.NODE_ENV === "production" && !apontaParaLoopback(valor)) return BASE_DA_GRAPH;
  return valor;
}
