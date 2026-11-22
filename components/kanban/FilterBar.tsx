"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PontoDaEtiqueta } from "@/components/tags/PontoDaEtiqueta";
import { useUser } from "@/hooks/auth/AuthProvider";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useAssignableAgents } from "@/hooks/kanban/useAssignableAgents";
import type { Lead, OwnerKind } from "@/lib/types/leads";
import { marcadoresDoCard } from "@/lib/kanban/marcadores-do-card";
import { OwnerBadge } from "./OwnerBadge";
import {
  agentOwnerFilter,
  marcadoresDoFiltro,
  parseAgentOwnerFilter,
  type LeadFilters,
} from "@/lib/kanban/filters";
import { categoriaDoMotivo } from "@/lib/leads/motivos-de-perda-do-funil";
import { rotuloDoMotivoDePerda } from "@/lib/schemas/leads";
import { cn } from "@/lib/utils";

interface FilterBarProps {
  filters: LeadFilters;
  onChange: (next: LeadFilters) => void;
  leads: Lead[];
  /**
   * O `settings` do funil do quadro: é dele que sai a categoria de cada motivo
   * de perda, que não é coluna do lead (DeskcommCRM #1717).
   */
  settings?: Record<string, unknown> | null;
}

const STATUS_OPTIONS: Array<{ value: NonNullable<LeadFilters["status"]>; label: string }> = [
  { value: "all", label: "Todos" },
  { value: "open", label: "Abertos" },
  { value: "won", label: "Ganhos" },
  { value: "lost", label: "Perdidos" },
];

export function FilterBar({ filters, onChange, leads, settings }: FilterBarProps) {
  const t = useT();
  const user = useUser();
  const { data: members } = useAssignableMembers(true);
  const { data: agents } = useAssignableAgents(true);
  const [searchInput, setSearchInput] = useState(filters.search ?? "");
  /**
   * A CAIXA ACOMPANHA O FILTRO (auditoria 16/11, achado 26). O filtro mora na
   * URL, e quem o muda não é só a caixa: "Limpar filtros" do aviso de quadro
   * vazio e o voltar do navegador limpavam a URL e a caixa seguia mostrando o
   * texto. Ajuste no RENDER, comparando com o valor anterior (o padrão que o
   * React documenta, sem efeito). `enviada` é o que a própria caixa mandou: a
   * URL que chega atrasada com ele não pode atropelar quem continuou digitando.
   */
  const buscaDoFiltro = filters.search ?? "";
  const [buscaVista, setBuscaVista] = useState(buscaDoFiltro);
  const [enviada, setEnviada] = useState<string | null>(null);
  if (buscaDoFiltro !== buscaVista) {
    setBuscaVista(buscaDoFiltro);
    if (buscaDoFiltro !== enviada) setSearchInput(buscaDoFiltro);
  }
  // O atraso lê o filtro de AGORA, não o do render em que a tecla foi
  // digitada: trocar Situação dentro dos 250 ms era desfeito quando a busca
  // saía com o filtro velho por baixo.
  const filtrosAtuais = useRef(filters);
  const aoMudar = useRef(onChange);
  useEffect(() => {
    filtrosAtuais.current = filters;
    aoMudar.current = onChange;
  });

  useEffect(() => {
    const espera = setTimeout(() => {
      const atuais = filtrosAtuais.current;
      if ((atuais.search ?? "") !== searchInput) {
        setEnviada(searchInput);
        aoMudar.current({ ...atuais, search: searchInput });
      }
    }, 250);
    return () => clearTimeout(espera);
  }, [searchInput]);

  /**
   * Quem OFERECE lê a MESMA regra de quem FILTRA (`applyFilters`) — ver
   * lib/kanban/marcadores-do-card.ts. Antes eram só `l.tags`, a caixa do
   * negócio: o marcador escrito no CONTATO não aparecia aqui nem casava lá.
   *
   * A varredura alcança o funil inteiro: a rota do quadro devolve todos os
   * cards de uma vez, sem paginar.
   */
  const tagOptions = useMemo(() => {
    const set = new Set<string>();
    for (const l of leads) for (const t of marcadoresDoCard(l)) set.add(t);
    return Array.from(set).sort();
  }, [leads]);

  const filteredAgentId = parseAgentOwnerFilter(filters.owner);

  /**
   * Responsáveis atribuíveis numa lista única — humanos e agentes ordenados
   * juntos. O dono de um lead é UM campo; quem pode ser dono aparece numa lista
   * só. A distinção é geométrica (avatar), nunca posicional.
   */
  const assignees = useMemo(() => {
    type Row = {
      key: string;
      owner: string;
      name: string;
      kind: OwnerKind;
      version: number | null;
    };
    const rows: Row[] = [
      ...(members ?? [])
        .filter((m) => m.user_id !== user.id)
        .map((m) => ({
          key: `u:${m.user_id}`,
          owner: m.user_id,
          name: m.full_name ?? t("Sem nome"),
          kind: "user" as OwnerKind,
          version: null,
        })),
      ...(agents ?? []).map((a) => ({
        key: `a:${a.agent_id}`,
        owner: agentOwnerFilter(a.agent_id),
        name: a.name,
        kind: "ai" as OwnerKind,
        version: a.version_number,
      })),
    ];
    return rows.sort((x, y) => x.name.localeCompare(y.name, "pt-BR"));
  }, [members, agents, user.id, t]);
  const ownerLabel =
    filters.owner === "unassigned"
      ? t("Sem responsável")
      : !filters.owner || filters.owner === "any"
        ? t("Todos")
        : filteredAgentId
          ? (agents?.find((a) => a.agent_id === filteredAgentId)?.name ?? t("Agente"))
          : filters.owner === user.id
            ? t("Eu")
            : (members?.find((m) => m.user_id === filters.owner)?.full_name ??
              t("Responsável"));

  const statusLabel = t(
    STATUS_OPTIONS.find((o) => o.value === (filters.status ?? "all"))?.label ?? "Todos",
  );

  // ⚠️ O RÓTULO DO GATILHO RESUME, E NÃO CORTA O FILTRO (#1274). O nome da
  // primeira etiqueta e o resto viram contagem: o que importa na tela é que há
  // filtro com DUAS etiquetas, e não qual é a segunda — ela está no menu, com a
  // caixa marcada. Uma etiqueta só mostra o nome dela, como sempre.
  const marcadoresEscolhidos = marcadoresDoFiltro(filters.tag);
  const tagLabel =
    marcadoresEscolhidos.length === 0
      ? t("Todas as etiquetas")
      : marcadoresEscolhidos.length === 1
        ? `${t("Etiqueta")}: ${marcadoresEscolhidos[0]}`
        : `${t("Etiqueta")}: ${marcadoresEscolhidos[0]} +${marcadoresEscolhidos.length - 1}`;
  const alternaEtiqueta = (tag: string) => {
    const escolhida = marcadoresEscolhidos.includes(tag);
    const proximas = escolhida
      ? marcadoresEscolhidos.filter((m) => m !== tag)
      : [...marcadoresEscolhidos, tag];
    onChange({
      ...filters,
      tag: proximas.length === 0 ? undefined : proximas,
      // O modo só faz sentido com DUAS: `?tag=vip&modo=ou` é um link que não
      // significa nada, e a chave de cache/url mudaria à toa.
      tagMode: proximas.length > 1 ? filters.tagMode : undefined,
    });
  };

  // Motivo e categoria da perda (DeskcommCRM #1717): as opções vêm do que ESTÁ
  // no quadro, e a categoria resolve pela MESMA régua de quem filtra.
  const motivosPerdidos = (() => {
    const set = new Set<string>();
    for (const l of leads) if (l.status === "lost" && l.lost_reason) set.add(l.lost_reason);
    return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR"));
  })();
  const categoriasPerdidas = Array.from(
    new Set(motivosPerdidos.map((m) => categoriaDoMotivo(m, settings)).filter((c): c is string => !!c)),
  ).sort((a, b) => a.localeCompare(b, "pt-BR"));
  // Só com a situação em Perdidos: fora dela os dois filtros esconderiam tudo.
  const mostraPerda = (filters.status ?? "all") === "lost" && motivosPerdidos.length > 0;
  const rotuloDoMotivo = (motivo: string) => {
    const rotulo = rotuloDoMotivoDePerda(motivo);
    return rotulo === motivo ? motivo : t(rotulo);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-2">
      <Input
        type="search"
        placeholder={t("Buscar por nome…")}
        value={searchInput}
        onChange={(e) => setSearchInput(e.target.value)}
        // A mesma altura e letra dos botões de filtro ao lado (Button `sm`):
        // a busca era mais alta e "Apenas atrasados" tinha letra maior
        // (achado 31). `md:text-xs` porque abaixo disso a letra fica em 16px,
        // o piso que impede o Safari do iPhone de dar zoom no campo.
        className="h-11 w-full md:text-xs lg:h-8 sm:w-64"
      />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            {t("Responsável")}: {ownerLabel}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>{t("Responsável")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onChange({ ...filters, owner: "any" })}>
            {t("Todos")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onChange({ ...filters, owner: "unassigned" })}>
            {t("Sem responsável")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onChange({ ...filters, owner: user.id })}>
            {t("Eu")}
          </DropdownMenuItem>
          {/*
            Humanos e agentes numa lista SÓ, ordenados juntos por nome. Não existe
            separador entre eles: separador agrupa, e agrupar comunica "as pessoas,
            e depois também os bots" — segregação por posição, que é a mesma ideia
            do badge "AI" colorido que o contrato de UI proíbe. Quem distingue é o
            avatar (disco preenchido = humano, círculo vazado com anel = agente),
            reusando o OwnerBadge do card para os dois não divergirem.
            O separador ACIMA (linha do "Eu") fica: ele divide as opções meta
            (Todos / Sem responsável / Eu) das pessoas, e ali agrupar está certo.
          */}
          {assignees.length > 0 && (
            <>
              <DropdownMenuSeparator />
              {assignees.map((a) => (
                <DropdownMenuItem key={a.key} onClick={() => onChange({ ...filters, owner: a.owner })}>
                  <OwnerBadge
                    ownerKind={a.kind}
                    ownerName={a.name}
                    agentVersion={a.version}
                  />
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            {t("Situação")}: {statusLabel}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {STATUS_OPTIONS.map((o) => (
            <DropdownMenuItem
              key={o.value}
              onClick={() => onChange({ ...filters, status: o.value })}
            >
              {t(o.label)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {mostraPerda ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {t("Motivo")}: {filters.lostReason ? rotuloDoMotivo(filters.lostReason) : t("Todos")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => onChange({ ...filters, lostReason: undefined })}>
              {t("Todos")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {motivosPerdidos.map((motivo) => (
              <DropdownMenuItem key={motivo} onClick={() => onChange({ ...filters, lostReason: motivo })}>
                {rotuloDoMotivo(motivo)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {mostraPerda && categoriasPerdidas.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {t("Categoria")}: {filters.lostCategory ? t(filters.lostCategory) : t("Todas")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => onChange({ ...filters, lostCategory: undefined })}>
              {t("Todas")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {categoriasPerdidas.map((categoria) => (
              <DropdownMenuItem key={categoria} onClick={() => onChange({ ...filters, lostCategory: categoria })}>
                {t(categoria)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={tagOptions.length === 0}>
            {marcadoresEscolhidos[0] ? (
              <PontoDaEtiqueta tag={marcadoresEscolhidos[0]} className="mr-2" />
            ) : null}
            {tagLabel}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem
            onClick={() => onChange({ ...filters, tag: undefined, tagMode: undefined })}
          >
            {t("Todas")}
          </DropdownMenuItem>
          {/* O E/OU só aparece com DUAS etiquetas. Com uma só o parâmetro não
              muda o resultado — e um controle que não muda nada é pior do que
              nenhum. */}
          {marcadoresEscolhidos.length > 1 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup
                value={filters.tagMode === "ou" ? "ou" : "e"}
                onValueChange={(modo) =>
                  onChange({ ...filters, tagMode: modo === "ou" ? "ou" : undefined })
                }
              >
                <DropdownMenuRadioItem value="e">{t("Com todas")}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="ou">{t("Com qualquer uma")}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </>
          )}
          <DropdownMenuSeparator />
          {/* Checkbox, e não item comum: `DropdownMenuCheckboxItem` marca e NÃO
              fecha o menu, que é o que permite escolher a segunda etiqueta sem
              reabrir o menu. O `onSelect` com `preventDefault` trava esse
              comportamento, porque o item de checkbox fecha por padrão. */}
          {tagOptions.map((tag) => (
            <DropdownMenuCheckboxItem
              key={tag}
              checked={marcadoresEscolhidos.includes(tag)}
              onCheckedChange={() => alternaEtiqueta(tag)}
              onSelect={(e) => e.preventDefault()}
            >
              <PontoDaEtiqueta tag={tag} className="mr-2" />
              {tag}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <label
        className={cn(
          "flex h-11 cursor-pointer select-none items-center gap-2 rounded-md border border-border px-3 text-xs font-medium lg:h-8",
          filters.overdueOnly && "border-accent bg-accent/10",
        )}
      >
        <input
          type="checkbox"
          checked={!!filters.overdueOnly}
          onChange={(e) => onChange({ ...filters, overdueOnly: e.target.checked })}
        />
        {t("Apenas atrasados")}
      </label>

      {(filters.search ||
        filters.owner ||
        marcadoresEscolhidos.length > 0 ||
        filters.overdueOnly ||
        filters.lostReason ||
        filters.lostCategory ||
        (filters.status && filters.status !== "all")) && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setSearchInput("");
            onChange({ status: "all" });
          }}
        >
          {t("Limpar filtros")}
        </Button>
      )}
    </div>
  );
}
