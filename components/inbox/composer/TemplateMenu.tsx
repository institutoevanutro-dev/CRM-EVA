"use client";
import { useT } from "@/hooks/i18n/useT";
import type { MessageTemplate } from "@/hooks/inbox/useMessageTemplates";
import { termoSemAcento } from "@/lib/inbox/termo-de-busca";
import { cn } from "@/lib/utils";

/** Estado do slash-menu a partir do texto do composer. Puro (testável). */
export function resolveSlash(text: string): { open: boolean; query: string } {
  if (!text.startsWith("/")) return { open: false, query: "" };
  const rest = text.slice(1);
  if (/\s/.test(rest)) return { open: false, query: "" };
  return { open: true, query: rest };
}

/**
 * Respostas rápidas que casam com o termo, pelo título ou pelo atalho, ignorando
 * caixa e acento dos dois lados (`/orcamento` acha "Orçamento" e vice-versa).
 * Termo vazio devolve a lista inteira; a ordem não muda; o título exibido também
 * não. Usada pelo menu do `/` e pela busca da barra de respostas.
 */
export function filtrarRespostas<T extends Pick<MessageTemplate, "title" | "shortcut">>(
  respostas: readonly T[],
  query: string,
): T[] {
  const q = termoSemAcento(query.trim());
  if (!q) return [...respostas];
  return respostas.filter(
    (r) => termoSemAcento(r.title).includes(q) || termoSemAcento(r.shortcut ?? "").includes(q),
  );
}

interface Props {
  open: boolean;
  query: string;
  templates: MessageTemplate[];
  onPick: (t: MessageTemplate) => void;
  onClose: () => void;
  /** A opção destacada pelas setas (item 43): Enter escolhe esta. */
  indice?: number;
}

/**
 * O menu do "/" (item 43 da auditoria de 17/11): setas e Enter escolhem, como no
 * menu de menção — antes só o mouse —, e o nome é o da tela onde elas se
 * cadastram, "Respostas rápidas".
 */
export function TemplateMenu({ open, query, templates, onPick, onClose: _onClose, indice = 0 }: Props) {
  const t = useT();
  if (!open) return null;
  const filtered = filtrarRespostas(templates, query);
  return (
    <div
      className="absolute bottom-14 left-3 z-20 max-h-64 w-80 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
      role="listbox"
      aria-label={t("Respostas rápidas")}
    >
      {filtered.length === 0 ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          {t("Nenhuma resposta rápida. Crie em Configurações.")}
        </div>
      ) : (
        filtered.map((tpl, i) => (
          <button
            key={tpl.id}
            type="button"
            role="option"
            aria-selected={i === indice}
            className={cn(
              "flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left hover:bg-muted",
              i === indice && "bg-muted",
            )}
            onClick={() => onPick(tpl)}
          >
            <span className="text-sm font-medium">{tpl.title}</span>
            <span className="line-clamp-1 text-xs text-muted-foreground">{tpl.body}</span>
          </button>
        ))
      )}
    </div>
  );
}
