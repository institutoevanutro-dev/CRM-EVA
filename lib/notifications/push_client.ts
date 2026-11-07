import { areAlertsEnabled, getPermission } from "./permission";
import { ensureNotifyServiceWorker } from "./service_worker";

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Liga a inscrição Web Push depois da permissão. Sem VAPID no servidor, no-op.
 *
 * Inscreve SEMPRE que o navegador concedeu a permissão, mesmo com "Nova
 * mensagem › Push" desligado: os avisos que pedem gente (a IA chamando a
 * equipe) chegam por esta mesma inscrição. O botão vai junto, em
 * `recebe_mensagens` (migration 0404), e o servidor deixa de mandar mensagem
 * nova a quem o desligou. Chame de novo quando o botão mudar.
 */
export async function syncPushSubscription(): Promise<void> {
  if (typeof window === "undefined") return;
  if (getPermission() !== "granted") return;
  const reg = await ensureNotifyServiceWorker();
  if (!reg?.pushManager) return;

  const cfg = await fetch("/api/v1/notifications/push").then((r) => r.json()).catch(() => null);
  const publicKey = cfg?.data?.public_key as string | undefined;
  if (!cfg?.data?.enabled || !publicKey) return;

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    });
  }

  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return;

  await fetch("/api/v1/notifications/push", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      recebe_mensagens: areAlertsEnabled(),
    }),
  });
}
