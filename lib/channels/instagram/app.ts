/**
 * O app do Instagram DESTA instalação (Instagram App ID + App Secret do produto
 * "Instagram" no app da Meta). Mesmo desenho de `../meta/app.ts`: banco primeiro
 * (`platform_meta_app`, cifrado), `.env` como piso de rollback, memo curto.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { logger } from "@/lib/logger";

export interface AppDoInstagram {
  appId: string | null;
  appSecret: string | null;
}

const TTL_MS = 60_000;
let memo: { valor: AppDoInstagram; expiraEm: number } | null = null;

const texto = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function invalidarAppDoInstagram(): void {
  memo = null;
}

export function instagramPodeConectar(app: AppDoInstagram): boolean {
  return Boolean(app.appId && app.appSecret);
}

export async function appDoInstagram(): Promise<AppDoInstagram> {
  if (memo && memo.expiraEm > Date.now()) return memo.valor;
  let valor: AppDoInstagram = {
    appId: texto(process.env.INSTAGRAM_APP_ID),
    appSecret: texto(process.env.INSTAGRAM_APP_SECRET),
  };
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("platform_meta_app")
      .select("ig_app_id, ig_app_secret_encrypted")
      .eq("id", 1)
      .maybeSingle();
    const linha = data as { ig_app_id: string | null; ig_app_secret_encrypted: string | null } | null;
    const appId = texto(linha?.ig_app_id);
    const cifrado = texto(linha?.ig_app_secret_encrypted);
    if (appId && cifrado) {
      const appSecret = texto(await decryptWebhookSecret(admin, cifrado));
      if (appSecret) valor = { appId, appSecret };
    }
  } catch (err) {
    logger.warn("[instagram.app] leitura do banco falhou; vale o .env", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  memo = { valor, expiraEm: Date.now() + TTL_MS };
  return valor;
}
