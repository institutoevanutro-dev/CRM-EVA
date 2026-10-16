import { ErroDeLeitura } from "@/components/empty/ErroDeLeitura";
import { CabecalhoDaPagina } from "@/components/shell/CabecalhoDaPagina";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import {
  EXPLICACAO_DA_ORIGEM,
  resolverChaveDeEmbedding,
} from "@/lib/ai/embeddings/chave";
import type { EstadoDaChave } from "@/components/ai/ChaveDeConhecimento";
import type { SourceRow } from "@/hooks/ai/useKnowledgeSources";
import { carregarUsoDoAcervo } from "@/lib/ai/knowledge/uso-do-acervo";
import { AcervoClient } from "./_client";

export const dynamic = "force-dynamic";

/**
 * O ACERVO DA ORGANIZAÇÃO.
 *
 * Esta página resolvia o agente com `.eq("is_default", true)` e mostrava quatro
 * cartões fixos, um por categoria. Como TODO agente criado pela interface nasce
 * `is_default: false`, só o agente semeado no bootstrap alcançava a tela — e
 * material de qualquer outro assistente era invisível aqui e no indexador.
 *
 * Desde a 0181 o acervo é da organização e cada assistente escolhe, na versão
 * publicada dele, o que consulta. Esta tela é a biblioteca; a escolha mora na
 * tela do agente.
 *
 * O estado da CHAVE vem do servidor junto com a lista, e não por fetch depois:
 * ele decide o que a tela pode prometer, e prometer primeiro para desmentir
 * depois é o defeito que esta página tinha.
 */
export default async function AcervoPage() {
  const user = await requireAuth();
  // `t` local em vez do hook: esta página é componente de SERVIDOR, e lá o
  // idioma vem resolvido em `user.idioma` (a cadeia pessoa → organização →
  // padrão vive em `lib/auth/server.ts`).
  const t = (texto: string) => traduzir(texto, user.idioma);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }


  const supabase = await createClient();

  const [{ data: sourcesRaw, error }, uso, chave, { data: credenciais }] =
    await Promise.all([
      supabase
        .from("ai_knowledge_sources")
        .select("*")
        .eq("organization_id", activeOrg.orgId)
        .order("created_at", { ascending: false }),
      // Quem pode consultar e quem consultou de verdade cada material. A tela
      // precisa disto para responder "se eu arquivar este material, quem para
      // de saber dele?" — sem essa resposta, arquivar é um tiro no escuro.
      carregarUsoDoAcervo(supabase, activeOrg.orgId),
      resolverChaveDeEmbedding(activeOrg.orgId),
      supabase
        .from("ai_provider_credentials_safe")
        .select("id, label, api_key_last4, validated_at, validation_error, is_active")
        .eq("organization_id", activeOrg.orgId)
        .eq("provider", "openai")
        .order("created_at", { ascending: true }),
    ]);

  const initialSources = (sourcesRaw ?? []) as unknown as SourceRow[];

  const estadoDaChave: EstadoDaChave = {
    pode_indexar: chave !== null,
    origem: chave?.origem ?? null,
    explicacao: chave ? EXPLICACAO_DA_ORIGEM[chave.origem] : null,
    chave_em_uso: chave?.rotulo ?? null,
    avisos: chave?.avisos ?? [],
    credenciais_openai: (credenciais ?? []) as EstadoDaChave["credenciais_openai"],
  };

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <CabecalhoDaPagina
        titulo={t("O que o agente sabe")}
        descricao={t(
            "O material do seu negócio que os assistentes consultam antes de responder. Cada assistente escolhe, na tela dele, o que pode ler daqui.",
          )}
      />

      {error ? (
        <ErroDeLeitura texto={t("Não foi possível carregar o material. Recarregue a página.")} />
      ) : (
        <AcervoClient
        initialSources={initialSources}
        initialChave={estadoDaChave}
        uso={uso}
      />
      )}
    </div>
  );
}
