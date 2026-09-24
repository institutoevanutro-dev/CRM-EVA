import { z } from "zod";
const cents = z.string().regex(/^\d{1,18}$/);
export const ResumoFinanceiro = z.object({
  versao: z.literal(1),
  paciente_id: z.string().uuid(),
  consultado_em: z.string(),
  limitado: z.boolean(),
  propostas: z
    .array(
      z.object({
        id: z.string().uuid(),
        numero: z.string().nullable(),
        status: z.enum(["rascunho", "enviada", "aprovada", "recusada", "expirada"]),
        total_cents: cents,
        validade: z.string(),
      }),
    )
    .max(100),
  vendas: z
    .array(
      z.object({
        id: z.string().uuid(),
        numero: z.string(),
        data: z.string(),
        situacao: z.enum(["cancelada", "atrasada", "quitada", "em_aberto"]),
        total_cents: cents,
        recebido_cents: cents,
        saldo_cents: cents,
      }),
    )
    .max(100),
});
export type ResumoFinanceiro = z.infer<typeof ResumoFinanceiro>;
export type ConfigFinanceiro = { url: string; token: string };
export function configFinanceiro(
  org: string,
  env: Record<string, string | undefined> = process.env,
): ConfigFinanceiro | null {
  if (
    !z.string().uuid().safeParse(org).success ||
    env.FINANCEIRO_ORGANIZATION_ID !== org ||
    !env.FINANCEIRO_TOKEN ||
    env.FINANCEIRO_TOKEN.length < 32
  )
    return null;
  try {
    const u = new URL(env.FINANCEIRO_URL ?? "");
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== "/"
    )
      return null;
    return { url: u.origin, token: env.FINANCEIRO_TOKEN };
  } catch {
    return null;
  }
}
export async function consultaFinanceiro(c: ConfigFinanceiro, id: string) {
  z.string().uuid().parse(id);
  try {
    const r = await fetch(`${c.url}/api/integracoes/crm/resumo?contato=${id}`, {
      headers: { "x-integracao-token": c.token },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error();
    const body = z.object({ data: ResumoFinanceiro.nullable() }).parse(await r.json());
    return {
      resumo: body.data,
      abrir_url: `${c.url}/pacientes/crm?contato=${id}`,
      base_url: c.url,
    };
  } catch {
    throw new Error("Financeiro indisponível. Tente atualizar novamente.");
  }
}
