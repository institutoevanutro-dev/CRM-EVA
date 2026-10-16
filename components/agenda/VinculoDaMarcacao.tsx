"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import { NewContactDialog } from "@/components/contacts/NewContactDialog";
import { nomeDoContato, rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
type Contato = {
  id: string;
  name: string | null;
  display_name: string | null;
  phone_number: string | null;
};
type Vinculos = {
  // `name` é nulo em todo contato que veio do WhatsApp — o nome está em
  // `display_name`. Por isso o rótulo sai de `rotuloDoContato`, nunca de `name`.
  contacts: Contato[];
  conversations: Array<{ id: string; created_at: string; status: string }>;
};

/** O que desempata dois "Marcelo": o telefone, quando o rótulo já não é ele. */
function desempate(c: Contato): string {
  return nomeDoContato(c) ? phoneForDisplay(c.phone_number) : "";
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
}: {
  contactId: string;
  conversationId: string;
  onChange: (contact: string, conversation: string) => void;
}) {
  const t = useT();
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
    <div className="space-y-3 rounded-lg border p-3">
      <label className="block">
        {t("Buscar cliente")}
        <input
          ref={campo}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={mostrarLista}
          aria-controls={listaId}
          aria-activedescendant={mostrarLista ? `${listaId}-${ativo}` : undefined}
          autoComplete="off"
          className="mt-1 w-full rounded-md border bg-surface p-2"
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
      </label>
      {/* Sempre no DOM: `aria-controls` aponta para ele mesmo com a lista fechada. */}
      <ul
        id={listaId}
        role="listbox"
        hidden={!mostrarLista}
        className="max-h-64 overflow-y-auto rounded-md border bg-surface"
      >
        {mostrarLista
          ? contatos.map((c, i) => (
              <li
                key={c.id}
                id={`${listaId}-${i}`}
                role="option"
                aria-selected={contactId ? c.id === contactId : i === ativo}
                // Alvo de toque generoso: quem marca faz isso no celular.
                className={`flex min-h-11 cursor-pointer flex-col justify-center px-3 text-sm ${i === ativo ? "bg-accent-soft" : ""}`}
                // O mousedown tiraria o foco do campo antes de o clique valer.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setAtivo(i)}
                onClick={() => escolher(c)}
              >
                <span className="font-medium">{rotuloDoContato(c, t)}</span>
                {desempate(c) ? <span className="text-xs text-text-muted">{desempate(c)}</span> : null}
              </li>
            ))
          : null}
      </ul>
      {nadaEncontrado ? (
        <div className="space-y-2">
          <p className="text-sm text-text-muted">{t("Nenhum paciente encontrado")}</p>
          <button
            type="button"
            // Alvo de toque generoso: quem marca faz isso no celular, com o
            // cliente esperando na frente.
            className="min-h-11 w-full rounded-md border border-dashed px-3 text-left text-sm"
            onClick={() => setCriando(true)}
          >
            {t("Criar")} “{search.trim()}”
          </button>
        </div>
      ) : null}
      <div>
        <p className="text-sm font-medium">{t("Quem será atendido")}</p>
        {contactId ? (
          <div
            data-testid="paciente-escolhido"
            data-contact-id={contactId}
            className="mt-1 flex flex-wrap items-center gap-2 rounded-md border bg-surface p-2"
          >
            <span className="flex-1">
              <span className="font-medium">{escolhido ? rotuloDoContato(escolhido, t) : "…"}</span>
              {escolhido && desempate(escolhido) ? (
                <span className="ml-2 text-xs text-text-muted">{desempate(escolhido)}</span>
              ) : null}
            </span>
            <button
              type="button"
              className="min-h-9 rounded-md border px-3 text-sm"
              onClick={() => semCliente(true)}
            >
              {t("Trocar")}
            </button>
            <button
              type="button"
              className="min-h-9 rounded-md px-3 text-sm text-text-muted underline"
              onClick={() => semCliente(false)}
            >
              {t("Compromisso pessoal, sem cliente")}
            </button>
          </div>
        ) : (
          <p className="mt-1 text-sm text-text-muted" data-testid="sem-paciente">
            {t("Compromisso pessoal, sem cliente")}
          </p>
        )}
      </div>
      {contactId ? (
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
        <p role="alert">{t("Não foi possível carregar os vínculos. Tente novamente.")}</p>
      ) : null}
      {/* `key` pelo termo: `nomeInicial` é defaultValue do formulário e só vale
          na montagem. Sem remontar, quem fecha e digita outro nome reabriria com
          o anterior. */}
      <NewContactDialog
        key={search.trim()}
        open={criando}
        onOpenChange={setCriando}
        nomeInicial={search.trim()}
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
