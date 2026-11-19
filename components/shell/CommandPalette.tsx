"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { buscaValeConsulta } from "@/lib/inbox/termo-de-busca";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { ChatCircle, MagnifyingGlass, UserCircle } from "@/lib/ui/icons";
import { NAV_GROUPS, searchable } from "@/lib/navigation/registry";
import { cn } from "@/lib/utils";

/**
 * Paleta de navegação (⌘K).
 *
 * Sem `cmdk`: o projeto já tem Dialog e Input, e uma lista filtrada com setas e
 * Enter são poucas linhas. Uma dependência a mais para isso seria peso sem ganho.
 *
 * Acha as telas do registro e, desde o item 233 (decisão do André, 18/11), também
 * contatos e conversas pelo nome ou telefone. Esses vêm das MESMAS rotas que as telas
 * de Contatos e Conversas usam (`/api/v1/contacts` e `/api/v1/conversations`), com a
 * sessão de quem busca: organização, papel e escopo são os delas, nada é decidido aqui.
 */

/** Uma linha da lista: tela, contato ou conversa. */
interface Item {
  chave: string;
  href: string;
  titulo: string;
  detalhe: string;
  rotulo: string;
  Icon: PhosphorIcon;
}

interface ContatoAchado {
  id: string;
  display_name: string | null;
  name: string | null;
  phone_number: string | null;
}
interface ConversaAchada {
  id: string;
  last_message_preview: string | null;
  contacts: ContatoAchado | null;
}

const nomeDe = (c: ContatoAchado | null) => c?.display_name || c?.name || c?.phone_number || "";

/** Até 5 de cada. Falha (papel sem acesso, rede) só deixa a parte vazia: as telas continuam. */
async function buscarPessoas(termo: string, signal: AbortSignal): Promise<Item[]> {
  const qs = `search=${encodeURIComponent(termo)}&limit=5`;
  const [contatos, conversas] = await Promise.all([
    apiClient.get<{ data: ContatoAchado[] }>(`/api/v1/contacts?${qs}`, { signal }).then((r) => r.data, () => []),
    apiClient.get<{ data: ConversaAchada[] }>(`/api/v1/conversations?${qs}`, { signal }).then((r) => r.data, () => []),
  ]);
  return [
    ...contatos.map((c) => ({
      chave: `contato-${c.id}`,
      href: `/app/contacts/${c.id}`,
      titulo: nomeDe(c),
      detalhe: c.phone_number ?? "",
      rotulo: "Contato",
      Icon: UserCircle,
    })),
    ...conversas.map((c) => ({
      chave: `conversa-${c.id}`,
      href: `/app/inbox?id=${c.id}`,
      titulo: nomeDe(c.contacts),
      detalhe: c.last_message_preview ?? "",
      rotulo: "Conversa",
      Icon: ChatCircle,
    })),
  ];
}

/** Sem acento e sem caixa: ninguém digita "orçamento" com cedilha às pressas. */
function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const ROTULO_GRUPO = new Map(NAV_GROUPS.map((g) => [g.id, g.label]));

export function CommandPalette({
  open,
  onOpenChange,
  aoNavegar,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Depois de abrir a escolha: a gaveta do celular fecha em vez de ficar por cima da tela nova. */
  aoNavegar?: () => void;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[15%] max-w-xl translate-y-0 gap-0 p-0">
        <DialogTitle className="sr-only">{t("Buscar telas")}</DialogTitle>
        {/* O miolo é um componente à parte porque o Radix o DESMONTA ao fechar:
            busca e destaque nascem zerados na próxima abertura por construção,
            sem um efeito de reset para manter em sincronia. */}
        <Resultados
          aoEscolher={() => {
            onOpenChange(false);
            aoNavegar?.();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function Resultados({ aoEscolher }: { aoEscolher: () => void }) {
  const t = useT();
  const router = useRouter();
  const { user, activeOrg } = useAuth();
  const [busca, setBusca] = useState("");
  const [destacado, setDestacado] = useState(0);

  const visiveis = useMemo(
    () =>
      searchable(
        user.is_platform_admin && !user.support,
        activeOrg?.role ?? null,
        activeOrg?.interface_settings,
      ),
    [user.is_platform_admin, user.support, activeOrg?.role, activeOrg?.interface_settings],
  );

  const telas = useMemo<Item[]>(() => {
    const termo = normalizar(busca.trim());
    // Sem termo, abre no trabalho do dia em vez de uma tela vazia que não
    // ensina nada sobre o que dá para procurar aqui.
    const achadas = !termo
      ? (() => {
          const daily = visiveis.filter((d) => d.group === "atendimento");
          return daily.length ? daily : visiveis.slice(0, 8);
        })()
      : visiveis.filter((d) => normalizar(`${d.label} ${d.description}`).includes(termo));
    return achadas.map((d) => ({
      chave: d.href,
      href: d.href,
      titulo: t(d.label),
      detalhe: t(d.description),
      rotulo: t(ROTULO_GRUPO.get(d.group) ?? ""),
      Icon: d.icon,
    }));
  }, [busca, visiveis, t]);

  // Contatos e conversas: só com termo que vale consulta, e um instante depois
  // da última tecla, para não pedir ao servidor a cada letra.
  const [pessoas, setPessoas] = useState<{ termo: string; itens: Item[] }>({ termo: "", itens: [] });
  useEffect(() => {
    const termo = busca.trim();
    if (!buscaValeConsulta(termo)) return;
    const ctrl = new AbortController();
    const espera = setTimeout(async () => {
      const itens = await buscarPessoas(termo, ctrl.signal);
      if (!ctrl.signal.aborted) setPessoas({ termo, itens });
    }, 250);
    return () => {
      clearTimeout(espera);
      ctrl.abort();
    };
  }, [busca]);

  const resultados = useMemo(
    () => [...telas, ...(pessoas.termo === busca.trim() ? pessoas.itens.map((p) => ({ ...p, rotulo: t(p.rotulo) })) : [])],
    [telas, pessoas, busca, t],
  );

  // As setas movem o destaque; a lista rola junto, senão o Enter abre algo fora de vista (item 234).
  useEffect(() => {
    document.getElementById(`palette-${destacado}`)?.scrollIntoView?.({ block: "nearest" });
  }, [destacado]);

  function navegar(destino: Item) {
    aoEscolher();
    router.push(destino.href);
  }

  /**
   * O destaque volta ao topo junto com a busca, no mesmo evento: mantê-lo
   * apontaria para outro item depois que a lista muda, e o Enter navegaria
   * para o lugar errado.
   */
  function aoDigitar(valor: string) {
    setBusca(valor);
    setDestacado(0);
  }

  function aoTeclar(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setDestacado((i) => Math.min(i + 1, resultados.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setDestacado((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const alvo = resultados[destacado];
      if (alvo) navegar(alvo);
    }
  }

  return (
    <>
      <div className="flex items-center gap-3 border-b px-4">
        <MagnifyingGlass size={16} aria-hidden className="shrink-0 text-muted-foreground" />
        <input
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls="palette-resultados"
          aria-activedescendant={resultados[destacado] ? `palette-${destacado}` : undefined}
          value={busca}
          onChange={(e) => aoDigitar(e.target.value)}
          onKeyDown={aoTeclar}
          placeholder={t("Buscar telas, contatos e conversas…")}
          className="h-12 w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground"
        />
      </div>

      {resultados.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          {t("Nada encontrado para")} “{busca}”.
        </p>
      ) : (
        <ul
          id="palette-resultados"
          role="listbox"
          aria-label={t("Resultados da busca")}
          className="max-h-80 overflow-y-auto p-2"
        >
          {resultados.map((d, i) => {
            const Icon = d.Icon;
            const ativo = i === destacado;
            // Na linha escolhida o fundo é de destaque: o cinza de apoio sumia nele (item 234).
            const apoio = ativo ? "text-accent-foreground opacity-80" : "text-muted-foreground";
            return (
              <li
                key={d.chave}
                id={`palette-${i}`}
                role="option"
                aria-selected={ativo}
                data-href={d.href}
                onMouseEnter={() => setDestacado(i)}
                onClick={() => navegar(d)}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-md px-3 py-2",
                  ativo && "bg-accent text-accent-foreground",
                )}
              >
                <Icon size={18} aria-hidden className={cn("mt-0.5 shrink-0", apoio)} />
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-sm font-medium">{d.titulo}</span>
                    <span className={cn("shrink-0 text-[11px] tracking-wider uppercase", apoio)}>{d.rotulo}</span>
                  </div>
                  {d.detalhe && <p className={cn("truncate text-xs", apoio)}>{d.detalhe}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
