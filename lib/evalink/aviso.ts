// Mesma lógica do Eva Financeiro (lib/auth/evalink-*.ts). Mudou lá, muda aqui.
import { createHmac, timingSafeEqual } from "node:crypto";

const hmac = (segredo: string, t: number, id: string, corpo: string) =>
  createHmac("sha256", segredo).update(`${t}.${id}.${corpo}`).digest("hex");

export function cabecalhoDeAviso(segredo: string, corpo: string, id: string, agoraMs = Date.now()) {
  const t = Math.floor(agoraMs / 1000);
  return `t=${t},id=${id},v1=${hmac(segredo, t, id, corpo)}`;
}

export function conferirAviso(segredo: string, corpo: string, cabecalho: string | null, agoraMs = Date.now(), janelaS = 300):
  { ok: true; id: string; t: number } | { ok: false; motivo: "sem_cabecalho" | "formato" | "fora_da_janela" | "assinatura" } {
  if (!cabecalho) return { ok: false, motivo: "sem_cabecalho" };
  const partes = Object.fromEntries(cabecalho.split(",").map((p) => p.split("=", 2) as [string, string]));
  const t = Number(partes.t), id = partes.id, v1 = partes.v1;
  if (!Number.isInteger(t) || !id || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return { ok: false, motivo: "formato" };
  if (Math.abs(Math.floor(agoraMs / 1000) - t) > janelaS) return { ok: false, motivo: "fora_da_janela" };
  const esperado = Buffer.from(hmac(segredo, t, id, corpo), "hex");
  if (!timingSafeEqual(esperado, Buffer.from(v1, "hex"))) return { ok: false, motivo: "assinatura" };
  return { ok: true, id, t };
}
