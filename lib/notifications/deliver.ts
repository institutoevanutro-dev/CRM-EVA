import { toast } from "sonner";

import { traduzir } from "@/lib/i18n/dicionario";
import { idiomaAtual } from "@/lib/i18n/IdiomaProvider";
import { emitNotification } from "./emit";
import { abrirNoApp } from "./notify_open";
import type { NotifyKind } from "./kinds";
import { canalLigado, type NotifyCategory } from "./prefs";

export interface EntregarAvisoInput {
  category: NotifyCategory;
  kind: NotifyKind;
  title: string;
  body: string;
  tag?: string;
  href?: string;
  icon?: string;
}

/** A pessoa está olhando para esta aba agora. */
function abaEmFoco(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();
}

export function entregarAviso(input: EntregarAvisoInput): void {
  // Mesmo padrão de showApiError: a chave do dicionário é o PT; sem `t()` o
  // toast da esquina fica em português mesmo com idioma=es (e as chaves de CRM
  // já existiam — o bug era não passar por traduzir).
  const idioma = idiomaAtual();
  const title = traduzir(input.title, idioma);
  const body = traduzir(input.body, idioma);

  const toastLigado = canalLigado(input.category, "in_app");
  if (toastLigado) {
    // O aviso já carrega o destino (`href`); com a ação, o toast leva direto
    // para a conversa. Sem destino, não inventa botão: botão morto é pior que
    // nenhum. (Porte do DeskcommCRM aea803e1c.) Só para destino de CONVERSA:
    // o aviso de lead também tem `href` (o funil), e um "Abrir conversa" que
    // abre o funil seria rótulo mentiroso.
    const href = input.href?.startsWith("/app/inbox") ? input.href : undefined;
    toast(title, {
      description: body,
      action: href
        ? { label: traduzir("Abrir conversa", idioma), onClick: () => abrirNoApp(href) }
        : undefined,
    });
  }
  // Com a aba em foco, o toast basta: aviso do sistema e som por cima dele
  // eram três avisos para a mesma coisa, na cara de quem já está olhando.
  if (canalLigado(input.category, "push") && !(toastLigado && abaEmFoco())) {
    emitNotification({
      kind: input.kind,
      title,
      body,
      tag: input.tag,
      href: input.href,
      icon: input.icon,
      force: true,
    });
  }
}
