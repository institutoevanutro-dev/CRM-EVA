import type { SupabaseClient } from "@supabase/supabase-js";

import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { logger } from "@/lib/logger";

import { ESCOLHA_PADRAO, lerEscolhaNoEnvio, type EscolhaNoEnvio } from "./escolha-no-envio";

/**
 * A LEITURA da escolha de envio (#3813) — separada do vocabulário de propósito.
 *
 * `lib/agenda/escolha-no-envio.ts` é importado por SCHEMAS (a validação da regra
 * e a do follow-up publicado), que rodam no caminho de save; trazer para lá a
 * leitura do banco arrastaria o motor de follow-up inteiro para dentro de uma
 * validação de payload. Aqui moram só as duas leituras — Supabase e `pg` — do
 * MESMO campo.
 *
 * ═══ Onde a escolha do FLUXO mora ═══
 *
 * Em `ai_agent_versions.followup.quando_ha_compromisso`, na configuração
 * publicada do agente pinado no enrollment: a mesma leitura serve aos dois
 * caminhos (o inline de `enviar-texto-fixo.ts` e o turno do worker).
 *
 * No fork, o original lia essa configuração por `janela-de-disparo.ts` /
 * `janela-de-followup.ts`, que não existem aqui; as duas leituras abaixo fazem
 * o mesmo caminho (enrollment → agente → versão publicada), com `null` quando
 * agente ou versão não existem.
 */

/** Supabase: enrollment → agente → versão publicada → `followup`. */
async function followupPublicadoSupabase(
  admin: SupabaseClient,
  organizationId: string,
  enrollmentId: string,
): Promise<unknown> {
  const { data: enr, error: e1 } = await admin
    .from("followup_enrollments")
    .select("agent_id")
    .eq("organization_id", organizationId)
    .eq("id", enrollmentId)
    .maybeSingle();
  if (e1) throw e1;
  const agentId = (enr as { agent_id?: string | null } | null)?.agent_id;
  if (!agentId) return null;
  const { data: ag, error: e2 } = await admin
    .from("ai_agents")
    .select("published_version_id")
    .eq("organization_id", organizationId)
    .eq("id", agentId)
    .maybeSingle();
  if (e2) throw e2;
  const versionId = (ag as { published_version_id?: string | null } | null)?.published_version_id;
  if (!versionId) return null;
  const { data: v, error: e3 } = await admin
    .from("ai_agent_versions")
    .select("followup")
    .eq("organization_id", organizationId)
    .eq("id", versionId)
    .maybeSingle();
  if (e3) throw e3;
  return (v as { followup?: unknown } | null)?.followup ?? null;
}

/** `pg`: a mesma leitura numa query só. */
async function followupPublicadoDoEnrollment(
  db: Queryable,
  organizationId: string,
  enrollmentId: string,
): Promise<unknown> {
  const { rows } = await db.query<{ followup: unknown }>(
    `select v.followup
       from followup_enrollments e
       left join ai_agents a on a.id = e.agent_id and a.organization_id = e.organization_id
       left join ai_agent_versions v on v.id = a.published_version_id and v.organization_id = e.organization_id
      where e.organization_id = $1 and e.id = $2`,
    [organizationId, enrollmentId],
  );
  return rows[0]?.followup ?? null;
}

/**
 * A escolha do fluxo de follow-up, da configuração publicada do agente pinado
 * no enrollment.
 *
 * Falha de leitura NÃO derruba o envio: cai no padrão (`adiar`), que é o
 * comportamento de hoje. O contrário — estourar — deixaria um campo de
 * preferência derrubar um fluxo inteiro; e o padrão é justamente o lado seguro.
 */
export async function escolhaDoFluxo(
  admin: SupabaseClient,
  organizationId: string,
  enrollmentId: string,
): Promise<EscolhaNoEnvio> {
  try {
    const followup = await followupPublicadoSupabase(admin, organizationId, enrollmentId);
    return lerEscolhaNoEnvio(followup);
  } catch (err) {
    logger.warn("[agenda] escolha do follow-up não lida; vale o padrão (adiar)", {
      organization_id: organizationId,
      enrollment_id: enrollmentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return ESCOLHA_PADRAO;
  }
}

/** A MESMA leitura do lado `pg` (o turno do worker fala `pg`, não PostgREST). */
export async function escolhaDoFluxoPg(
  db: Queryable,
  organizationId: string,
  enrollmentId: string,
): Promise<EscolhaNoEnvio> {
  try {
    const followup = await followupPublicadoDoEnrollment(db, organizationId, enrollmentId);
    return lerEscolhaNoEnvio(followup);
  } catch (err) {
    logger.warn("[agenda] escolha do follow-up não lida (pg); vale o padrão (adiar)", {
      organization_id: organizationId,
      enrollment_id: enrollmentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return ESCOLHA_PADRAO;
  }
}
