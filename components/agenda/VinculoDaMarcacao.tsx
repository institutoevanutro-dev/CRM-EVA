"use client";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { format } from "date-fns";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useContact } from "@/hooks/contacts/useContact";
import { CpfDoContato } from "@/components/contacts/CpfDoContato";
import { NewContactDialog } from "@/components/contacts/NewContactDialog";
import { dataDeCalendario, idadeEmAnos, ultimaEProximaConsulta } from "@/lib/agenda/marcacao-simples";
import { nomeDoContato, rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { telefoneLegivel } from "@/lib/channels/phone-variants";
import { CaretDown, MagnifyingGlass } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { CAMPO } from "./CampoDaMarcacao";
import { iniciaisDe } from "./paleta";
export type ContatoDaMarcacao = {
  id: string;
  name: string | null;
  display_name: string | null;
  phone_number: string | null;
  /** Desempatam homônimos na busca. Ausentes em servidor mais velho. */
  email?: string | null;
  birthdate?: string | null;
  /** Pediu para não receber mensagens: o lembrete não sai (A10). Ausente em servidor mais velho. */
  is_blocked?: boolean;
};
type Contato = ContatoDaMarcacao;
type Vinculos = {
  // `name` é nulo em todo contato que veio do WhatsApp — o nome está em
  // `display_name`. Por isso o rótulo sai de `rotuloDoContato`, nunca de `name`.
  contacts: Contato[];
  conversations: Array<{ id: string; created_at: string; status: string }>;
};

/**
 * O que desempata dois "Marcelo" na lista: o telefone (quando o rótulo já não é
 * ele), a idade e o e-mail. A idade separa homônimos melhor que o DDD.
 */
function desempate(c: Contato, t: (s: string) => string, agora: Date): string {
  const idade = idadeEmAnos(c.birthdate, agora);
  return [
    nomeDoContato(c) ? telefoneLegivel(c.phone_number) : "",
    idade === null ? "" : `${idade} ${t("anos")}`,
    c.email ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Quem será atendido numa marcação: busca com lista VISÍVEL (combobox ARIA).
 *
 * Até a 4.12.0 a busca só filtrava as opções DENTRO de um `select` fechado, que
 * seguia mostrando "Compromisso pessoal, sem cliente". Em produção o dono da
 * clínica digitou "Marcelo", a busca achou 11 pessoas, nada mudou na tela, e
 * ele concluiu que não dava para marcar paciente. Agora quem a busca acha
 * aparece logo abaixo do campo, e quem foi escolhido aparece com nome e Trocar.
 *
 * O campo fica SEMPRE na tela, inclusive com alguém escolhido: a pré-escolha
 * automática (um só bateu) acontece enquanto a pessoa ainda digita, e sumir com
 * o campo ali engoliria as teclas seguintes.
 */
export function VinculoDaMarcacao({
  contactId,
  conversationId,
  onChange,
  onContato,
  compacto = false,
}: {
  contactId: string;
  conversationId: string;
  onChange: (contact: string, conversation: string) => void;
  /**
   * O cadastro de quem está escolhido, assim que ele chega (`null` sem ninguém
   * ou enquanto carrega). O modal precisa dele para saber se falta o nome
   * completo, inclusive quando o paciente veio pronto da conversa (`?contato=`).
   */
  onContato?: (contato: ContatoDaMarcacao | null) => void;
  /**
   * A versão do modal simples de marcação: sem caixa em volta, rótulo
   * "Paciente" e a lista de resultados flutuando sobre o formulário em vez de
   * empurrá-lo para baixo.
   */
  compacto?: boolean;
}) {
  const t = useT();
  const agora = new Date();
  const listaId = useId();
  const campo = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [aberta, setAberta] = useState(false);
  const [ativo, setAtivo] = useState(0);
  const [criando, setCriando] = useState(false);
  const query = useQuery({
    queryKey: ["agenda", "vinculos", contactId, search],
    queryFn: async () =>
      (
        await apiClient.get<{ data: Vinculos }>(
          `/api/v1/agenda/vinculos?${new URLSearchParams(contactId ? { contact_id: contactId } : { q: search })}`,
        )
      ).data,
  });
  const contatos = query.data?.contacts ?? [];
  const escolhido = contactId ? contatos.find((c) => c.id === contactId) : undefined;
  useEffect(() => {
    onContato?.(escolhido ?? null);
  }, [escolhido, onContato]);

  // Quem marca horário costuma estar com a pessoa na frente, e ela nem sempre
  // já é contato. Sem esta saída o fluxo PARA aqui: teria que abandonar a
  // marcação, ir até Contatos, criar, voltar e recomeçar. O termo já digitado
  // vira o nome, e o contato volta selecionado.
  const buscou = search.trim().length > 0 && !contactId;
  const nadaEncontrado = buscou && !query.isLoading && contatos.length === 0;
  // Busca vazia não abre lista: o endpoint devolve os 30 primeiros da base, e
  // isso não é resultado de nada que a pessoa pediu. Com alguém escolhido pela
  // pré-escolha automática a lista CONTINUA aberta: a pessoa vê quem foi achado
  // e confirma ou troca; quem escolheu clicando ou com Enter já a fechou.
  const mostrarLista = aberta && search.trim().length > 0 && contatos.length > 0;

  // Um só bateu: já vem escolhido (e continua trocável). Uma vez por termo,
  // senão "Trocar" ou "Compromisso pessoal" seriam desfeitos no render seguinte.
  const autoPara = useRef<string | null>(null);
  useEffect(() => {
    const achados = query.data?.contacts ?? [];
    const unico = achados.length === 1 ? achados[0] : undefined;
    if (!buscou || query.isFetching || !unico) return;
    if (autoPara.current === search) return;
    autoPara.current = search;
    onChange(unico.id, "");
  }, [buscou, query.isFetching, query.data, search, onChange]);

  function escolher(c: Contato) {
    onChange(c.id, "");
    setAberta(false);
  }
  function semCliente(focar: boolean) {
    setSearch("");
    setAberta(false);
    onChange("", "");
    if (focar) campo.current?.focus();
  }

  return (
    <div className={compacto ? "relative" : "space-y-3 rounded-lg border p-3"}>
      <label className="block">
        <span className={compacto ? "mb-1.5 block text-xs font-medium text-text-muted" : "block"}>
          {compacto ? t("Paciente") : t("Buscar cliente")}
        </span>
        <span className="relative block">
          {compacto ? (
            <MagnifyingGlass
              size={16}
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle"
            />
          ) : null}
          <input
            ref={campo}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={mostrarLista}
            aria-controls={listaId}
            aria-activedescendant={mostrarLista ? `${listaId}-${ativo}` : undefined}
            autoComplete="off"
            className={compacto ? cn(CAMPO, "pl-9") : "mt-1 w-full rounded-md border bg-surface p-2"}
            placeholder={compacto ? t("Buscar pelo nome ou telefone") : undefined}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setAberta(true);
              setAtivo(0);
              onChange("", "");
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                if (!mostrarLista) {
                  setAberta(true);
                  return;
                }
                const passo = e.key === "ArrowDown" ? 1 : -1;
                setAtivo((i) => (i + passo + contatos.length) % contatos.length);
              } else if (e.key === "Enter" && mostrarLista) {
                e.preventDefault();
                const c = contatos[ativo];
                if (c) escolher(c);
              } else if (e.key === "Escape" && mostrarLista) {
                // O painel de marcação (Sheet) também fecha no Escape; ele olha o
                // `aria-expanded` deste campo e, com a lista aberta, deixa quieto.
                setAberta(false);
              }
            }}
          />
        </span>
      </label>
      {/* Sempre no DOM: `aria-controls` aponta para ele mesmo com a lista fechada. */}
      <ul
        id={listaId}
        role="listbox"
        hidden={!mostrarLista}
        className={
          compacto
            ? "absolute inset-x-0 z-30 mt-1 max-h-64 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg"
            : "max-h-64 overflow-y-auto rounded-md border bg-surface"
        }
      >
        {mostrarLista
          ? contatos.map((c, i) => {
              const detalhe = desempate(c, t, agora);
              return (
                <li
                  key={c.id}
                  id={`${listaId}-${i}`}
                  role="option"
                  aria-selected={contactId ? c.id === contactId : i === ativo}
                  // Alvo de toque generoso: quem marca faz isso no celular.
                  className={cn(
                    "flex min-h-11 cursor-pointer flex-col justify-center rounded-md px-3 py-1.5 text-sm",
                    i === ativo && "bg-accent-soft",
                  )}
                  // O mousedown tiraria o foco do campo antes de o clique valer.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setAtivo(i)}
                  onClick={() => escolher(c)}
                >
                  <span className="truncate font-medium text-text">{rotuloDoContato(c, t)}</span>
                  {detalhe ? <span className="truncate text-xs tabular-nums text-text-muted">{detalhe}</span> : null}
                </li>
              );
            })
          : null}
      </ul>
      {nadaEncontrado ? (
        <div className={compacto ? "mt-2 space-y-2" : "space-y-2"}>
          <p className="text-sm text-text-muted">{t("Nenhum paciente encontrado")}</p>
          <button
            type="button"
            // Alvo de toque generoso: quem marca faz isso no celular, com o
            // cliente esperando na frente.
            className="min-h-11 w-full rounded-md border border-dashed border-border-strong px-3 text-left text-sm text-text transition-colors duration-fast hover:border-accent hover:bg-accent-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-500"
            onClick={() => setCriando(true)}
          >
            {t("Criar")} “{search.trim()}”
          </button>
        </div>
      ) : null}
      {contactId ? (
        <PacienteEscolhido
          contactId={contactId}
          contato={escolhido}
          agora={agora}
          onTrocar={() => semCliente(true)}
          onSemCliente={() => semCliente(false)}
          conversa={
            compacto
              ? {
                  id: conversationId,
                  opcoes: query.data?.conversations ?? [],
                  onChange: (conversa) => onChange(contactId, conversa),
                }
              : undefined
          }
        />
      ) : (
        <p
          className={compacto ? "mt-1.5 text-xs text-text-subtle" : "mt-1 text-sm text-text-muted"}
          data-testid="sem-paciente"
        >
          {t("Compromisso pessoal, sem cliente")}
        </p>
      )}
      {/* No modal a conversa mora no cartão do paciente (é a conversa DELE). */}
      {contactId && !compacto ? (
        <label className="block">
          {t("Conversa vinculada (opcional)")}
          <select
            className="mt-1 w-full rounded-md border bg-surface p-2"
            value={conversationId}
            onChange={(e) => onChange(contactId, e.target.value)}
          >
            <option value="">{t("Sem conversa vinculada")}</option>
            {query.data?.conversations.map((c, i) => (
              <option key={c.id} value={c.id}>
                {t("Conversa")} {i + 1} · {new Date(c.created_at).toLocaleDateString()}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {query.isError ? (
        <p role="alert" className="mt-1 text-xs text-error-fg">
          {t("Não foi possível carregar os vínculos. Tente novamente.")}
        </p>
      ) : null}
      {/* `key` pelo termo: `nomeInicial` é defaultValue do formulário e só vale
          na montagem. Sem remontar, quem fecha e digita outro nome reabriria com
          o anterior. */}
      <NewContactDialog
        key={search.trim()}
        open={criando}
        onOpenChange={setCriando}
        nomeInicial={search.trim()}
        permitirIniciarConversa={false}
        onCriado={(contato) => {
          // Volta JÁ SELECIONADO. A busca passa a ser o nome do contato, e o
          // termo fica marcado como resolvido para a pré-escolha automática não
          // disparar de novo por cima.
          const nome = contato.name ?? search;
          autoPara.current = nome;
          setSearch(nome);
          setAberta(false);
          onChange(contato.id, "");
        }}
      />
    </div>
  );
}

/**
 * O cartão de CONFERÊNCIA: escolhido o paciente, os dados que temos dele, para a
 * recepção ter certeza de que é a pessoa certa antes de marcar — dois "Marcelo"
 * com o mesmo DDD se separam pela idade, pelo e-mail ou pela última consulta.
 *
 * Nome, telefone, e-mail e nascimento vêm da busca (`/api/v1/agenda/vinculos`);
 * o CPF e as consultas, da ficha (`GET /api/v1/contacts/[id]`, a mesma da tela do
 * contato, que audita a abertura como `contact.viewed`). O CPF aparece MASCARADO:
 * o número só sai pelo "Ver CPF", que decifra no servidor e audita
 * (`contact.cpf_viewed`).
 */
function PacienteEscolhido({
  contactId,
  contato,
  agora,
  onTrocar,
  onSemCliente,
  conversa,
}: {
  contactId: string;
  contato: Contato | undefined;
  agora: Date;
  onTrocar: () => void;
  onSemCliente: () => void;
  /** A conversa vinculada, quando o cartão a mostra (o modal). */
  conversa?: { id: string; opcoes: Vinculos["conversations"]; onChange: (id: string) => void };
}) {
  const t = useT();
  const locale = useLocaleDeData();
  const ficha = useContact(contactId);
  const dados = ficha.data?.data;
  const nome = contato ? rotuloDoContato(contato, t) : null;
  const idade = idadeEmAnos(contato?.birthdate, agora);
  const nascimento = dataDeCalendario(contato?.birthdate);
  const consultas = Array.isArray(dados?.consultas) ? dados.consultas : null;
  const { ultima, proxima } = ultimaEProximaConsulta(consultas ?? [], agora);
  const quando = (iso: string) => format(new Date(iso), "dd/MM/yyyy", { locale });

  const itens: Array<{ rotulo: string; valor: ReactNode; chave: string }> = [];
  if (contato?.phone_number && nomeDoContato(contato))
    itens.push({ chave: "telefone", rotulo: t("Telefone"), valor: telefoneLegivel(contato.phone_number) });
  if (contato?.email) itens.push({ chave: "email", rotulo: t("E-mail"), valor: contato.email });
  if (nascimento)
    itens.push({
      chave: "nascimento",
      rotulo: t("Nascimento"),
      valor: idade === null ? nascimento : `${nascimento} · ${idade} ${t("anos")}`,
    });
  if (dados?.cpf_available)
    itens.push({
      chave: "cpf",
      rotulo: t("CPF"),
      valor: <CpfDoContato contactId={contactId} disponivel podeVer finalidade="conferir paciente na agenda" />,
    });
  if (consultas)
    itens.push({
      chave: "ultima",
      rotulo: t("Última consulta"),
      valor: ultima ? `${quando(ultima.starts_at)} · ${ultima.title}` : t("Nenhuma ainda"),
    });
  if (proxima)
    itens.push({ chave: "proxima", rotulo: t("Próxima"), valor: `${quando(proxima.starts_at)} · ${proxima.title}` });

  return (
    <div
      data-testid="paciente-escolhido"
      data-contact-id={contactId}
      className="anima-revela mt-2 rounded-lg border border-border bg-surface-muted/50 p-3"
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent-strong"
        >
          {nome ? iniciaisDe(nome) : ""}
        </span>
        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-text">{nome ?? "…"}</p>
        <button
          type="button"
          onClick={onTrocar}
          className="h-8 shrink-0 rounded-md border border-border bg-surface px-3 text-xs font-medium text-text transition-colors duration-fast hover:border-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-500 toque:h-11"
        >
          {t("Trocar")}
        </button>
      </div>
      {itens.length > 0 || ficha.isLoading ? (
        <dl
          data-testid="dados-do-paciente"
          className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-2.5 text-xs"
        >
          {itens.map((i) => (
            <div key={i.chave} data-dado={i.chave} className="flex min-w-0 max-w-full items-baseline gap-1.5">
              <dt className="shrink-0 text-text-subtle">{i.rotulo}</dt>
              <dd className="min-w-0 truncate tabular-nums text-text">{i.valor}</dd>
            </div>
          ))}
          {ficha.isLoading ? (
            <div aria-hidden className="h-4 w-40 animate-pulse rounded-sm bg-border" />
          ) : null}
        </dl>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <button
          type="button"
          onClick={onSemCliente}
          className="text-xs text-text-muted underline decoration-border-strong underline-offset-2 transition-colors duration-fast hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-500"
        >
          {t("Compromisso pessoal, sem cliente")}
        </button>
        {conversa ? (
          <label className="flex min-w-0 items-center gap-1.5 text-xs text-text-subtle">
            <span aria-hidden>{t("Conversa")}</span>
            <span className="relative min-w-0">
              <select
                aria-label={t("Conversa vinculada (opcional)")}
                value={conversa.id}
                onChange={(e) => conversa.onChange(e.target.value)}
                className="h-7 max-w-48 appearance-none truncate rounded-md border border-border-input bg-surface pl-2 pr-7 text-xs text-text outline-hidden transition-[border-color,box-shadow] duration-fast focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-500/30 toque:h-11"
              >
                <option value="">{t("Sem conversa vinculada")}</option>
                {conversa.opcoes.map((c, i) => (
                  <option key={c.id} value={c.id}>
                    {t("Conversa")} {i + 1} · {new Date(c.created_at).toLocaleDateString()}
                  </option>
                ))}
              </select>
              <CaretDown
                size={12}
                weight="bold"
                aria-hidden
                className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-text-subtle"
              />
            </span>
          </label>
        ) : null}
      </div>
    </div>
  );
}
