/**
 * MediaSource do WAHA: baixa o binário hospedado pelo container WAHA.
 *
 * A URL anunciada no webhook NÃO é confiável nem correta: o HMAC é
 * best-effort (payload forjado é possível) e o WAHA anuncia seu endereço
 * INTERNO (ex.: localhost:3000 dentro do container, mapeado p/ 3030 no
 * host). Por isso o fetch é SEMPRE reconstruído sobre WAHA_API_BASE_URL.
 *
 * Trocar o host NÃO bastava: path e query sobreviviam, e o fetch leva a
 * X-Api-Key GLOBAL do WAHA. Uma `media_url` como `http://x/api/sessions` lia a
 * API inteira do WAHA (auditoria 2026-09-29, C4). Agora só passa o arquivo da
 * PRÓPRIA sessão: `/api/files/<sessão>/<arquivo>`, sem query. O nome de arquivo
 * real é o id da mensagem (`false_5511…@c.us_3EB0….oga`), daí o `@`. A futura MetaMediaSource
 * implementa a mesma assinatura baixando via media_id + Graph API.
 */
import {
  MAX_MEDIA_BYTES,
  MediaTooLargeError,
  type FetchedMedia,
} from "@/lib/messaging/media/types";

const FETCH_TIMEOUT_MS = 30_000;

const ARQUIVO = /^\/api\/files\/([^/]+)\/[A-Za-z0-9@._-]+$/;

export async function fetchWahaMedia(
  mediaUrl: string,
  hintMime: string | null | undefined,
  sessionName: string,
): Promise<FetchedMedia> {
  const base = process.env.WAHA_API_BASE_URL;
  let advertised: URL;
  try {
    advertised = new URL(mediaUrl);
  } catch {
    throw new Error("waha_media_untrusted_host");
  }
  // `URL` já resolveu `..` e `%2e%2e`; o que sobra tem de ser um arquivo, não API.
  const m = ARQUIVO.exec(advertised.pathname);
  if (!m || decodeURIComponent(m[1]!) !== sessionName) {
    throw new Error("waha_media_untrusted_path");
  }
  let url: URL;
  try {
    url = new URL(advertised.pathname, base ?? "");
  } catch {
    throw new Error("waha_media_untrusted_host");
  }

  const apiKey = process.env.WAHA_API_KEY;
  const res = await fetch(url.toString(), {
    headers: apiKey ? { "X-Api-Key": apiKey } : {},
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`waha_media_${res.status}`);

  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_MEDIA_BYTES) throw new MediaTooLargeError();

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > MAX_MEDIA_BYTES) throw new MediaTooLargeError();

  const mime = res.headers.get("content-type") || hintMime || "application/octet-stream";
  return { buffer, mime };
}
