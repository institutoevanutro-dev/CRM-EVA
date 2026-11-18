/**
 * QUEM PODE TROCAR A SENHA SEM SABER A ATUAL (auditoria 17/11, item 48).
 *
 * A tela `/login/reset` troca a senha de quem estiver na sessão. Ela foi feita
 * para a sessão que o link de "Esqueci minha senha" abre — mas aceitava QUALQUER
 * sessão. Um link vencido ou já usado, aberto num navegador onde outra pessoa
 * estava logada (o computador da recepção), caía em `/auth/confirm`, que
 * preserva a sessão existente para o segundo clique não expulsar ninguém, e a
 * tela seguinte trocava a senha DESSA outra pessoa, sem dizer de quem era.
 *
 * A sessão sozinha não diz de onde veio: medido no GoTrue local em 18/11, a de
 * recuperação tem `amr = [{ method: "otp" }]`, igual à do link mágico (e à do
 * EvaLink, que entra por ele). Quem diz é esta marca, gravada só quando
 * `/auth/confirm` acabou de verificar um link de recuperação COM sucesso, com o
 * id e o e-mail que o GoTrue devolveu para aquele token. A troca exige a marca
 * e o mesmo usuário na sessão.
 *
 * Assinada, e não o id cru: a primeira carga de `/login/reset` vem de um clique
 * no webmail, navegação de outro site, e o cookie de sessão (SameSite=Strict)
 * não viaja nela. A tela mostra o e-mail só pela marca, então a marca não pode
 * ser algo que qualquer um escreve no próprio navegador para ler o e-mail de um
 * id alheio.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const COOKIE_TROCA_DE_SENHA = "troca_de_senha";

/** O link de recuperação vale uma hora no GoTrue; a troca não vive mais que ele. */
export const PRAZO_DA_TROCA_S = 60 * 60;

const segredo = (): string =>
  process.env.INVITE_TOKEN_SECRET ?? process.env.INTERNAL_SECRET ?? "dev-fallback";

const assinar = (corpo: string) => createHmac("sha256", `troca-de-senha:${segredo()}`).update(corpo).digest("base64url");

export function marcaDaTroca(userId: string, email: string, agoraMs = Date.now()): string {
  const corpo = Buffer.from(
    JSON.stringify({ u: userId, e: email, exp: Math.floor(agoraMs / 1000) + PRAZO_DA_TROCA_S }),
  ).toString("base64url");
  return `${corpo}.${assinar(corpo)}`;
}

/** `null` = sem marca, marca forjada ou vencida. */
export function lerMarcaDaTroca(
  valor: string | undefined | null,
  agoraMs = Date.now(),
): { userId: string; email: string } | null {
  const [corpo, sig, sobra] = (valor ?? "").split(".");
  if (!corpo || !sig || sobra !== undefined) return null;
  const esperada = assinar(corpo);
  if (sig.length !== esperada.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(esperada))) return null;
  try {
    const { u, e, exp } = JSON.parse(Buffer.from(corpo, "base64url").toString()) as Record<string, unknown>;
    if (typeof u !== "string" || typeof e !== "string" || typeof exp !== "number") return null;
    if (exp * 1000 <= agoraMs) return null;
    return { userId: u, email: e };
  } catch {
    return null;
  }
}
