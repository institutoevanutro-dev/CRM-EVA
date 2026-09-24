import { audit } from "@/lib/audit";
import type { createAdminClient } from "@/lib/supabase/admin";
import { consultaFinanceiro, type ConfigFinanceiro } from "./cliente";

type Admin = ReturnType<typeof createAdminClient>;
type Contato = { id: string; name: string | null };
export type ResultadoNomes = { consultados: number; atualizados: number; falhas: number };

/** A consulta remota é isolada para testar a regra sem dados reais de pacientes. */
export async function reconciliarNomes(
  contatos: Contato[],
  consultar: (id: string) => Promise<{ resumo: { paciente_nome?: string } | null }>,
  gravar: (id: string, nome: string | null) => Promise<boolean>,
): Promise<ResultadoNomes> {
  const resultado = { consultados: 0, atualizados: 0, falhas: 0 };
  for (const contato of contatos) {
    if (contato.name?.trim()) continue;
    resultado.consultados++;
    try {
      const { resumo } = await consultar(contato.id);
      const nome = resumo?.paciente_nome?.trim();
      if (nome && nome.length <= 200) {
        if (await gravar(contato.id, nome)) resultado.atualizados++;
      } else {
        await gravar(contato.id, null);
      }
    } catch {
      resultado.falhas++;
      // Avança a fila mesmo se a API falhar; a próxima volta tentará de novo.
      try { await gravar(contato.id, null); } catch { /* falha já contabilizada */ }
    }
  }
  return resultado;
}

export async function sincronizarNomesFinanceiro(
  admin: Admin,
  org: string,
  config: ConfigFinanceiro,
): Promise<ResultadoNomes> {
  const { data, error } = await admin
    .from("contacts")
    .select("id,name")
    .eq("organization_id", org)
    .eq("is_anonymized", false)
    .or("name.is.null,name.eq.")
    .order("financeiro_name_lookup_at", { ascending: true, nullsFirst: true })
    .limit(40);
  if (error) throw new Error("Não foi possível selecionar contatos sem nome.");

  return reconciliarNomes(
    (data ?? []) as Contato[],
    async (id) => consultaFinanceiro(config, id),
    async (id, nome) => {
      const patch = {
        financeiro_name_lookup_at: new Date().toISOString(),
        ...(nome ? { name: nome } : {}),
      };
      const { data: afetadas, error: updateError } = await admin
        .from("contacts")
        .update(patch)
        .eq("organization_id", org)
        .eq("id", id)
        .eq("is_anonymized", false)
        .or("name.is.null,name.eq.")
        .select("id");
      if (updateError) throw new Error("Não foi possível atualizar contato.");
      const atualizou = (afetadas ?? []).length > 0;
      if (nome && atualizou) {
        await audit({
          action: "contact.updated",
          organizationId: org,
          resourceType: "contact",
          resourceId: id,
          metadata: { source: "financeiro", fields: ["name"] },
        });
      }
      return !!nome && atualizou;
    },
  );
}
