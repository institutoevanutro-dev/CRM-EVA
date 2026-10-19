/**
 * Configurações → Conversões. Onde quem administra liga o aviso de agendamento
 * para a Meta e o Google Ads e vê o que saiu ou não saiu.
 *
 * O único evento é "um paciente agendou". A tela diz com todas as letras o que
 * sai e o que nunca sai, porque quem liga isto responde pelo dado do paciente.
 *
 * ── Por que ADMIN CLIENT para ler ───────────────────────────────────────────
 *
 * `ad_platform_connections` e `ad_conversion_dispatches` são deny-all (RLS
 * ligada, zero policies, grants revogados): pelo client de sessão a página
 * mostraria vazio. O gate de papel abaixo autoriza; a leitura é no servidor.
 *
 * ── Por que `admin`, e não `manager` ────────────────────────────────────────
 *
 * O objeto é uma credencial que escreve na conta de anúncios da empresa e uma
 * decisão sobre dado de paciente. Mesmo gate de `settings/marca`.
 */
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import {
  lerEstadoDasConversoes,
  MOTIVO_LEGIVEL,
  STATUS_LEGIVEL,
} from "@/lib/conversoes/estado-da-conexao";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

import { FormularioGoogle, FormularioMeta, PreferenciaDeOrigem } from "./_form";

export const metadata = { title: "Conversões" };
export const dynamic = "force-dynamic";

const NOME_DA_PLATAFORMA = { meta_ads: "Meta", google_ads: "Google Ads" } as const;

export default async function ConversoesPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }

  const estado = await lerEstadoDasConversoes(createAdminClient(), activeOrg.orgId);
  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-[2rem] leading-tight">{t("Conversões")}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t(
            "Quando um paciente agenda, o sistema pode avisar a Meta e o Google Ads. É esse retorno que ensina o anúncio a procurar mais gente parecida com quem agendou. Vem desligado: só sai depois que você ligar abaixo.",
          )}
        </p>
      </header>

      <section className="grid max-w-3xl gap-3 rounded-md border p-4 text-sm sm:grid-cols-2">
        <div>
          <h2 className="mb-1 font-semibold">{t("O que sai")}</h2>
          <ul className="list-disc pl-5 text-muted-foreground">
            <li>{t("Que houve um agendamento, e a hora em que ele foi feito.")}</li>
            <li>{t("O telefone do paciente (e o e-mail, se houver), embaralhado de forma irreversível (SHA-256).")}</li>
            <li>{t("Um código do evento que não dá para desfazer, para a plataforma não contar duas vezes.")}</li>
            <li>{t("O identificador do clique no anúncio, quando o contato tiver.")}</li>
          </ul>
        </div>
        <div>
          <h2 className="mb-1 font-semibold">{t("O que nunca sai")}</h2>
          <ul className="list-disc pl-5 text-muted-foreground">
            <li>{t("Nome, procedimento, tipo de consulta, profissional, observações, etapa do funil, valor ou qualquer dado de saúde.")}</li>
            <li>{t("Nada de quem está bloqueado, marcado como sempre atendimento humano, oculto ou anonimizado.")}</li>
            <li>{t("Nada quando o agendamento é cancelado depois: o que já saiu fica, e nada novo é enviado.")}</li>
          </ul>
        </div>
      </section>

      <PreferenciaDeOrigem somenteDeAnuncio={estado.preferencias.somenteDeAnuncio} idioma={idioma} />

      {estado.meta.testEventCode && (
        <div className="rounded-md border border-info/40 bg-info/10 p-4 text-sm">
          {t("Modo de teste da Meta ligado: os agendamentos vão marcados como teste e não contam para a otimização.")}
        </div>
      )}

      <FormularioMeta estado={estado.meta} idioma={idioma} />
      <FormularioGoogle estado={estado.google} idioma={idioma} />

      <p className="max-w-3xl text-xs text-muted-foreground">
        {t(
          "Limite conhecido: a conexão do WhatsApp por QR não recebe o identificador do clique do anúncio, e nenhum caminho captura o do Google ainda. Sem ele, a plataforma tenta casar só pelo telefone criptografado, e parte dos agendamentos pode não ser atribuída ao anúncio.",
        )}
      </p>

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">{t("Últimos avisos de agendamento")}</h2>
          <span className="text-sm text-muted-foreground">
            {estado.enviados} {t("enviados com sucesso")}
          </span>
        </div>
        {estado.envios.length === 0 ? (
          <p className="rounded-md border p-4 text-sm text-muted-foreground">
            {t("Nenhum aviso ainda. Ou o envio está desligado, ou nenhum paciente que se encaixa agendou desde que foi ligado.")}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-3 font-medium">{t("Agendamento")}</th>
                  <th className="p-3 font-medium">{t("Plataforma")}</th>
                  <th className="p-3 font-medium">{t("Situação")}</th>
                  <th className="p-3 font-medium">{t("Quando")}</th>
                </tr>
              </thead>
              <tbody>
                {estado.envios.map((e) => (
                  <tr key={`${e.agendamentoId}:${e.plataforma}`} className="border-t align-top">
                    <td className="p-3">
                      <a className="underline underline-offset-2" href={`/app/agenda?compromisso=${e.agendamentoId}`}>
                        {t("Abrir")}
                      </a>
                    </td>
                    <td className="p-3 whitespace-nowrap">{NOME_DA_PLATAFORMA[e.plataforma] ?? e.plataforma}</td>
                    <td className="p-3">
                      <span>{t(STATUS_LEGIVEL[e.status] ?? e.status)}</span>
                      {e.motivo && (
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {t(MOTIVO_LEGIVEL[e.motivo] ?? e.motivo)}
                          {e.codigo ? ` (${e.codigo})` : ""}
                        </span>
                      )}
                    </td>
                    <td className="p-3 whitespace-nowrap text-muted-foreground">
                      {new Date(e.tentadoEm).toLocaleString(idioma, { dateStyle: "short", timeStyle: "short" })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
