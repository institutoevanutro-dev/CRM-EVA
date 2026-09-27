import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";
import type { PapelEvalink } from "./oidc";

export type MotivoRecusa = "falhou" | "conflito" | "sem_org_padrao" | "sem_organizacao" | "ultimo_admin";

/** Decide a entrada via `fn_evalink_entrada` (T2). Nunca lança: qualquer falha vira `motivo: "falhou"`. */
export async function decidirEntrada(admin: SupabaseClient,
  d: { sub: string; email: string; papel: PapelEvalink; orgPadrao: string }) {
  const r = await admin.rpc("fn_evalink_entrada", { p_sub: d.sub, p_email: d.email, p_papel: d.papel, p_org_padrao: d.orgPadrao });
  const linha = (r.data as { user_id: string | null; motivo: string | null }[] | null)?.[0];
  if (r.error || !linha) return { ok: false as const, motivo: "falhou" as const };
  if (linha.motivo === null && linha.user_id) {
    const u = await admin.auth.admin.getUserById(linha.user_id);
    if (u.error || !u.data.user?.email) return { ok: false as const, motivo: "falhou" as const };
    // Levanta um banimento herdado de uma desconexão anterior: a pessoa foi
    // religada (a Conta mandou a entrada de novo), então o acesso volta.
    // Sem isto, o RPC religa o vínculo mas a conta continua banida para
    // sempre, e nem link de recovery a tira de lá.
    const unban = await admin.auth.admin.updateUserById(linha.user_id, { ban_duration: "none" });
    if (unban.error) return { ok: false as const, motivo: "falhou" as const };
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
  const conhecidos: MotivoRecusa[] = ["conflito", "sem_org_padrao", "sem_organizacao", "ultimo_admin"];
  return { ok: false as const, motivo: (conhecidos as string[]).includes(linha.motivo ?? "") ? (linha.motivo as MotivoRecusa) : "falhou" };
}

/**
 * Banir é seguro para esta pessoa? Não é quando ela é o último admin ativo de alguma
 * organização ou admin de plataforma ativo: o ban trancaria a instalação sem ninguém para
 * destrancá-la pela tela. Erro de leitura falha segura: não bane (e registra).
 */
async function podeBanir(admin: SupabaseClient, userId: string): Promise<boolean> {
  const plat = await admin.from("platform_admins").select("user_id").eq("user_id", userId).is("revoked_at", null).limit(1);
  if (plat.error) {
    logger.error("evalink_aviso_checagem_falhou", { userId, erro: plat.error.message });
    return false;
  }
  if ((plat.data ?? []).length > 0) return false;

  const minhas = await admin.from("user_organizations").select("organization_id")
    .eq("user_id", userId).eq("role", "admin").is("revoked_at", null);
  if (minhas.error) {
    logger.error("evalink_aviso_checagem_falhou", { userId, erro: minhas.error.message });
    return false;
  }
  const orgs = (minhas.data ?? []).map((l: { organization_id: string }) => l.organization_id);
  if (orgs.length === 0) return true;

  const outros = await admin.from("user_organizations").select("organization_id, user_id")
    .in("organization_id", orgs).eq("role", "admin").is("revoked_at", null).neq("user_id", userId);
  if (outros.error) {
    logger.error("evalink_aviso_checagem_falhou", { userId, erro: outros.error.message });
    return false;
  }
  // Outro admin já banido (um aviso anterior) não conta: o vínculo dele segue ativo, mas ele
  // não entra. Sem isto, desligar os dois admins de uma org, um depois do outro, trancava a org.
  const linhas = (outros.data ?? []) as { organization_id: string; user_id: string }[];
  const ativos = new Set<string>();
  for (const id of new Set(linhas.map((l) => l.user_id))) {
    const u = await admin.auth.admin.getUserById(id);
    if (u.error) {
      logger.error("evalink_aviso_checagem_falhou", { userId, erro: u.error.message });
      return false;
    }
    const ate = (u.data.user as { banned_until?: string | null } | null)?.banned_until ?? null;
    if (!ate || new Date(ate) <= new Date()) ativos.add(id);
  }
  const cobertas = new Set(linhas.filter((l) => ativos.has(l.user_id)).map((l) => l.organization_id));
  return orgs.every((o) => cobertas.has(o));
}

/**
 * Desligado ou acesso removido também fecha a senha de reserva: o Supabase não aceita senha
 * nula, então vira um valor aleatório descartado. E bane a conta: sem isto, um link de
 * recovery/magiclink/email que a pessoa já tinha na caixa de entrada continuava dando sessão
 * depois da desconexão. A senha de reserva é só UMA das portas, não a única.
 *
 * Exceção: o último admin ativo de alguma organização e o admin de plataforma ativo não são
 * banidos (ver `podeBanir`). A senha troca do mesmo jeito e o RPC derruba as sessões.
 *
 * As duas trocas acontecem ANTES do `fn_evalink_aviso`: esse RPC já marca o aviso como visto na
 * primeira chamada, então se elas viessem depois e falhassem, a reentrega da Conta bateria em
 * "repetido" para sempre e o acesso antigo continuaria valendo. Trocar antes é seguro: uma
 * reentrega troca de novo, sem efeito colateral.
 */
export async function aplicarAviso(admin: SupabaseClient, d: { sub: string; avisoId: string; motivo: string }) {
  let userId: string | null = null;
  let banido = false;
  if (d.motivo === "desligado" || d.motivo === "acesso_removido") {
    const v = await admin.from("evalink_vinculos").select("user_id").eq("evalink_sub", d.sub).maybeSingle();
    if (v.error) throw new Error("evalink_aviso_falhou");
    if (v.data?.user_id) {
      userId = v.data.user_id as string;
      const u = await admin.auth.admin.updateUserById(userId, { password: randomBytes(32).toString("base64url") });
      if (u.error) throw new Error("evalink_aviso_falhou");
      if (await podeBanir(admin, userId)) {
        const b = await admin.auth.admin.updateUserById(userId, { ban_duration: "876000h" });
        if (b.error) throw new Error("evalink_aviso_falhou");
        banido = true;
      }
    }
  }
  const r = await admin.rpc("fn_evalink_aviso", { p_sub: d.sub, p_aviso: d.avisoId });
  if (r.error) throw new Error("evalink_aviso_falhou");
  const linha = (r.data as { user_id: string | null; novo: boolean }[] | null)?.[0];
  if (!linha) throw new Error("evalink_aviso_falhou");
  return {
    resultado: linha.novo ? ("feito" as const) : ("repetido" as const),
    userId: linha.user_id ?? userId,
    banido,
  };
}
