"use client";
import { useT } from "@/hooks/i18n/useT";

/**
 * O aviso do agente legado que ainda não atende.
 *
 * Era um cartão com um formulário próprio — canal, provedor e modelo em texto
 * livre, chave numa lista à parte — logo acima do editor, que já pede as mesmas
 * coisas com as listas certas em "A inteligência que ele usa" e "Por qual número
 * ele atende". Duas portas para o mesmo dado, uma delas sem lista. Agora o aviso
 * só explica, e a configuração se conclui no editor: as instruções do legado já
 * abrem nele (`buildState` em `AgentForm.tsx`), e publicar dispara o mesmo
 * registro de "agente recuperado" (`trg_agent_legacy_published`).
 */
export function LegacyRecovery({ hasVersion }: { hasVersion: boolean }) {
  const t = useT();
  return (
    <section
      className="space-y-2 rounded-md border border-warning/40 bg-warning-bg p-4"
      aria-label={t("Recuperar agente legado")}
    >
      <h2 className="font-medium">
        {t("Este agente precisa concluir a configuração para atender.")}
      </h2>
      <p className="text-sm">
        {hasVersion
          ? t("Já existe uma versão preservada. Revise, teste e publique pelo editor abaixo.")
          : t(
              "As instruções dele já estão no editor abaixo. Escolha o número, a inteligência e a chave, salve o rascunho e publique.",
            )}
      </p>
    </section>
  );
}
