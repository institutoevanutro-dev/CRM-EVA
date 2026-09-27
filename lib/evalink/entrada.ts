import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";
import type { PapelEvalink } from "./oidc";

export type MotivoRecusa = "falhou" | "conflito" | "sem_organizacao" | "ultimo_admin";

/** Decide a entrada via `fn_evalink_entrada` (T2). Nunca lança: qualquer falha vira `motivo: "falhou"`. */
export async function decidirEntrada(admin: SupabaseClient,
  d: { sub: string; email: string; papel: PapelEvalink; orgPadrao: string }) {
  const r = await admin.rpc("fn_evalink_entrada", { p_sub: d.sub, p_email: d.email, p_papel: d.papel, p_org_padrao: d.orgPadrao });
  const linha = (r.data as { user_id: string | null; motivo: string | null }[] | null)?.[0];
  if (r.error || !linha) return { ok: false as const, motivo: "falhou" as const };
  if (linha.motivo === null && linha.user_id) {
    const u = await admin.auth.admin.getUserById(linha.user_id);
    if (u.error || !u.data.user?.email) return { ok: false as const, motivo: "falhou" as const };
    return { ok: true as const, userId: linha.user_id, email: u.data.user.email };
  }
  if (linha.motivo === "novo") {
    const c = await admin.auth.admin.createUser({ email: d.email, email_confirm: true });
    if (c.error || !c.data.user) return { ok: false as const, motivo: "falhou" as const };
    const l = await admin.rpc("fn_evalink_ligar_novo", { p_user: c.data.user.id, p_sub: d.sub, p_org: d.orgPadrao, p_papel: d.papel });
    if (l.error) {
      const del = await admin.auth.admin.deleteUser(c.data.user.id);
      if (del.error) logger.error("evalink_compensacao_falhou", { userId: c.data.user.id, erro: del.error.message });
      return { ok: false as const, motivo: "falhou" as const };
    }
    return { ok: true as const, userId: c.data.user.id, email: d.email };
  }
  const conhecidos: MotivoRecusa[] = ["conflito", "sem_organizacao", "ultimo_admin"];
  return { ok: false as const, motivo: (conhecidos as string[]).includes(linha.motivo ?? "") ? (linha.motivo as MotivoRecusa) : "falhou" };
}

/**
 * Desligado ou acesso removido também fecha a senha de reserva: o Supabase não aceita senha
 * nula, então vira um valor aleatório descartado.
 *
 * A troca acontece ANTES do `fn_evalink_aviso`: esse RPC já marca o aviso como visto na
 * primeira chamada, então se a troca de senha viesse depois e falhasse, a reentrega da Conta
 * bateria em "repetido" para sempre e a senha antiga ficaria valendo. Trocar antes é seguro: uma
 * reentrega troca de novo, sem efeito colateral.
 */
export async function aplicarAviso(admin: SupabaseClient, d: { sub: string; avisoId: string; motivo: string }) {
  if (d.motivo === "desligado" || d.motivo === "acesso_removido") {
    const v = await admin.from("evalink_vinculos").select("user_id").eq("evalink_sub", d.sub).maybeSingle();
    if (v.error) throw new Error("evalink_aviso_falhou");
    if (v.data?.user_id) {
      const u = await admin.auth.admin.updateUserById(v.data.user_id, { password: randomBytes(32).toString("base64url") });
      if (u.error) throw new Error("evalink_aviso_falhou");
    }
  }
  const r = await admin.rpc("fn_evalink_aviso", { p_sub: d.sub, p_aviso: d.avisoId });
  if (r.error) throw new Error("evalink_aviso_falhou");
  const linha = (r.data as { user_id: string | null; novo: boolean }[] | null)?.[0];
  if (!linha) throw new Error("evalink_aviso_falhou");
  return linha.novo ? ("feito" as const) : ("repetido" as const);
}
