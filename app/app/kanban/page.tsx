import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { CabecalhoDaPagina } from "@/components/shell/CabecalhoDaPagina";
import { traduzir } from "@/lib/i18n/dicionario";
import { FunisClient, type FunilDaLista } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Funis" };

/**
 * A lista de funis — e o lugar onde eles se gerenciam.
 *
 * ⚠️ O FILTRO DE `organization_id` NÃO É REDUNDANTE COM A RLS, e a falta dele era
 * um bug visível: a policy `crm_pipelines_select` libera TODAS as organizações do
 * usuário (`organization_id in fn_user_org_ids()`) e libera tudo para
 * `fn_is_platform_admin()`. Quem participa de duas organizações via as duas
 * listas misturadas — e como o gatilho `trg_seed_default_pipeline_for_org` semeia
 * um funil "Pedidos" em toda organização nova, a tela mostrava várias linhas
 * idênticas, indistinguíveis, cada uma levando a um quadro diferente. A RLS
 * responde "pode ver?"; a tela precisa responder "quer ver agora?".
 *
 * ⚠️ A LEITURA É ABERTA, A ESCRITA É manager+. Ver a lista e abrir o quadro é
 * trabalho de qualquer papel; criar, renomear, reordenar e arquivar é
 * configuração — e é o que `requireRole("manager")` cobra nas rotas.
 * `podeGerenciar` usa o MESMO critério delas (o papel na organização ativa, sem
 * atalho de platform admin, que as rotas não concedem por padrão): mostrar um
 * botão que o servidor recusaria seria prometer o que não se cumpre.
 */
export default async function KanbanPickerPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("crm_pipelines")
    // `is_client_pipeline` entra: sem ela o selo "Clientes" não aparecia ao
    // carregar a página e o botão sempre oferecia "Funil de clientes", mesmo no
    // funil já marcado — só o corpo de um PATCH trazia a coluna.
    //
    // ⚠️ `is_archived` DEIXOU DE SER FILTRO E VIROU COLUNA (#979). Antes a
    // consulta cortava os arquivados no banco, e o resultado era um funil
    // invisível e indestrutível: quem arquivou não tinha como ver, tirar do
    // arquivo nem excluir o que arquivou. A separação passou para a partição
    // abaixo — a lista de trabalho continua só com os vivos.
    .select("id, name, slug, description, position, is_default, is_client_pipeline, is_archived")
    .eq("organization_id", activeOrg.orgId)
    .order("position");

  const todos = (data ?? []) as Array<FunilDaLista & { is_archived: boolean }>;
  const funis = todos.filter((f) => !f.is_archived);
  const podeGerenciar = ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;
  // O arquivo só vai para quem pode mexer nele: tirar do arquivo e excluir são
  // `requireRole("manager")` nas rotas, e mostrar a gaveta a quem receberia 403
  // seria prometer o que não se cumpre — mesmo critério de `podeGerenciar`.
  const arquivados = podeGerenciar ? todos.filter((f) => f.is_archived) : [];
  // Importar planilha é ESCRITA DE OPERAÇÃO, não configuração: quem atende
  // sobe a lista que recebeu. Espelha o `requireRole("agent")` da rota.
  const podeImportar = ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent;
  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      {/* Era "Pipelines" — nome de quem construiu o sistema, não de quem vende. */}
      <CabecalhoDaPagina
        titulo={t("Funis")}
        descricao={t("As etapas por onde cada paciente passa até fechar. Abra um funil para ver o quadro.")}
      />

      {error ? (
        // Falha de leitura não pode cair no "Criar meu primeiro funil": a
        // equipe concluiria que os funis sumiram.
        <p className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-text-muted" data-testid="funis-erro">
          {t("Não foi possível carregar os funis. Recarregue a página.")}
        </p>
      ) : (

      <FunisClient
        funis={funis}
        arquivados={arquivados}
        podeGerenciar={podeGerenciar}
        podeImportar={podeImportar}
      />
      )}
    </div>
  );
}
