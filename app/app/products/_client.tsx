"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CabecalhoDaPagina } from "@/components/shell/CabecalhoDaPagina";
import { apiClient } from "@/lib/api/client";
import { formatCents } from "@/lib/money";
import { precoParaCentavos, type Produto } from "@/lib/schemas/produtos";

interface Textos {
  titulo: string;
  subtitulo: string;
  vazio: string;
  vazioDica: string;
}

interface ResumoDaImportacao {
  total_linhas: number;
  criados: number;
  atualizados: number;
  erros: Array<{ linha: number; motivo: string }>;
  colunas_ignoradas: string[];
}

interface Rascunho {
  codigo: string;
  nome: string;
  marca: string;
  categoria: string;
  preco: string;
  custo: string;
  quantidade: string;
  controla_estoque: boolean;
}

const VAZIO: Rascunho = {
  codigo: "",
  nome: "",
  marca: "",
  categoria: "",
  preco: "",
  custo: "",
  quantidade: "0",
  controla_estoque: true,
};

function centavosParaTexto(c: number): string {
  return (c / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function doProduto(p: Produto): Rascunho {
  return {
    codigo: p.codigo,
    nome: p.nome,
    marca: p.marca ?? "",
    categoria: p.categoria ?? "",
    preco: centavosParaTexto(p.preco_cents),
    custo: p.custo_cents === null ? "" : centavosParaTexto(p.custo_cents),
    quantidade: String(p.quantidade),
    controla_estoque: p.controla_estoque,
  };
}

function doRascunho(
  r: Rascunho,
  t: (s: string) => string,
  editando = false,
): Record<string, unknown> | { erro: string } {
  const preco_cents = precoParaCentavos(r.preco);
  if (preco_cents === null) return { erro: t("Preço inválido. Escreva assim: 5.499,00") };
  const custo_cents = r.custo.trim() === "" ? null : precoParaCentavos(r.custo);
  if (r.custo.trim() !== "" && custo_cents === null) return { erro: t("Custo inválido.") };

  return {
    codigo: r.codigo.trim(),
    nome: r.nome.trim(),
    // Na edição marca e categoria vão sempre: apagar o campo tem de apagar o
    // valor, e omitir a chave faria o PATCH manter o antigo.
    ...(editando || r.marca.trim() ? { marca: r.marca.trim() } : {}),
    ...(editando || r.categoria.trim() ? { categoria: r.categoria.trim() } : {}),
    preco_cents,
    custo_cents,
    controla_estoque: r.controla_estoque,
    quantidade: Number(r.quantidade) || 0,
  };
}

export function ProdutosClient({
  inicial,
  podeEditar,
  textos,
  erroDeLeitura = false,
}: {
  inicial: Produto[];
  podeEditar: boolean;
  textos: Textos;
  /** A leitura do catálogo falhou no servidor — não é a mesma coisa que vazio. */
  erroDeLeitura?: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const [busca, setBusca] = React.useState("");
  const [criando, setCriando] = React.useState(false);
  /** O produto em edição; o formulário é o mesmo do cadastro. */
  const [editando, setEditando] = React.useState<Produto | null>(null);
  const [rascunho, setRascunho] = React.useState<Rascunho>(VAZIO);
  const [salvando, setSalvando] = React.useState(false);
  const [importando, setImportando] = React.useState(false);
  const [resumo, setResumo] = React.useState<ResumoDaImportacao | null>(null);
  const arquivoRef = React.useRef<HTMLInputElement>(null);

  const filtrados = React.useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (q === "") return inicial;
    return inicial.filter((p) =>
      [p.nome, p.codigo, p.marca ?? "", p.categoria ?? ""].join(" ").toLowerCase().includes(q),
    );
  }, [inicial, busca]);

  async function salvar() {
    const corpo = doRascunho(rascunho, t, editando !== null);
    if ("erro" in corpo) {
      toast.error(corpo.erro as string);
      return;
    }
    setSalvando(true);
    try {
      if (editando) {
        await apiClient.patch(`/api/v1/products/${editando.id}`, corpo);
        toast.success(t("Produto atualizado"));
      } else {
        await apiClient.post("/api/v1/products", corpo);
        toast.success(t("Produto cadastrado"));
      }
      fecharFormulario();
      router.refresh();
    } catch (e) {
      showApiError(e);
    } finally {
      setSalvando(false);
    }
  }

  function fecharFormulario() {
    setRascunho(VAZIO);
    setCriando(false);
    setEditando(null);
  }

  function abrirEdicao(p: Produto) {
    setEditando(p);
    setCriando(false);
    setRascunho(doProduto(p));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function importar(arquivo: File) {
    setImportando(true);
    setResumo(null);
    try {
      const form = new FormData();
      form.append("file", arquivo);
      const res = await fetch("/api/v1/products/import", { method: "POST", body: form });
      const json = (await res.json()) as
        | { data: ResumoDaImportacao }
        | { error?: { message?: string } };
      if (!res.ok || !("data" in json)) {
        const msg = "error" in json ? json.error?.message : undefined;
        toast.error(msg ?? t("Não consegui ler essa planilha."));
        return;
      }
      // O resumo fica NA TELA, não num toast que some em 4 segundos: quem
      // importou 300 produtos precisa ler quais linhas foram recusadas e por quê.
      setResumo(json.data);
      router.refresh();
    } catch {
      toast.error(t("Não consegui enviar o arquivo."));
    } finally {
      setImportando(false);
      if (arquivoRef.current) arquivoRef.current.value = "";
    }
  }

  async function alternarAtivo(p: Produto) {
    try {
      await apiClient.patch(`/api/v1/products/${p.id}`, { ativo: !p.ativo });
      toast.success(t(p.ativo ? "Produto desativado" : "Produto reativado"));
      router.refresh();
    } catch (e) {
      showApiError(e);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl p-6" data-testid="tela-produtos">
      <CabecalhoDaPagina
        className="mb-6"
        titulo={textos.titulo}
        descricao={textos.subtitulo}
        acoes={
          podeEditar ? (
            <>
              <input
                ref={arquivoRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                data-testid="arquivo-planilha"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importar(f);
                }}
              />
              {/* O modelo mora AO LADO de importar: é o primeiro passo dela, e
                  solto numa linha própria parecia um link perdido. */}
              <a
                href="/api/v1/products/import"
                download="modelo-catalogo.csv"
                className="text-xs text-text-muted underline"
                data-testid="modelo-planilha"
              >
                {t("Baixar planilha modelo")}
              </a>
              <Button
                variant="outline"
                disabled={importando}
                onClick={() => arquivoRef.current?.click()}
                data-testid="importar-planilha"
              >
                {t(importando ? "Importando…" : "Importar planilha (.csv)")}
              </Button>
              <Button
                onClick={() => {
                  if (criando || editando) fecharFormulario();
                  else setCriando(true);
                }}
                data-testid="novo-produto"
              >
                {t(criando || editando ? "Cancelar" : "Novo produto")}
              </Button>
            </>
          ) : null
        }
      />

      <div className="mb-4">
        <Input
          type="search"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder={t("Buscar por nome, código ou marca")}
          className="max-w-sm"
          data-testid="busca-produto"
        />
      </div>

      {resumo ? (
        <div className="mb-6 rounded-lg border p-4 text-sm" data-testid="resumo-importacao">
          <p className="font-medium">
            {resumo.criados} {t("novos")} · {resumo.atualizados} {t("atualizados")} ·{" "}
            {resumo.total_linhas} {t("linhas na planilha")}
          </p>
          {resumo.colunas_ignoradas.length > 0 ? (
            <p className="mt-2 text-muted-foreground">
              {t("Não usei estas colunas:")} {resumo.colunas_ignoradas.join(", ")}.
            </p>
          ) : null}
          {resumo.erros.length > 0 ? (
            <div className="mt-3">
              <p className="font-medium">{t("Linhas que não entraram:")}</p>
              <ul className="mt-1 space-y-0.5 text-muted-foreground">
                {resumo.erros.slice(0, 20).map((e) => (
                  <li key={`${e.linha}-${e.motivo}`}>
                    {t("Linha")} {e.linha}: {e.motivo}
                  </li>
                ))}
              </ul>
              {resumo.erros.length > 20 ? (
                <p className="mt-1 text-muted-foreground">
                  {t("…e mais")} {resumo.erros.length - 20}.
                </p>
              ) : null}
            </div>
          ) : null}
          <button className="mt-3 text-xs underline" onClick={() => setResumo(null)}>
            {t("Fechar")}
          </button>
        </div>
      ) : null}

      {(criando || editando) && podeEditar ? (
        <div className="mb-6 rounded-lg border p-4" data-testid="form-produto">
          {editando ? (
            <p className="mb-3 text-sm font-medium" data-testid="editando-produto">
              {t("Editando")} {editando.nome}
            </p>
          ) : null}
          {editando?.origem === "precificaeva" ? (
            <p className="mb-3 rounded-md border border-warning/40 bg-warning-bg p-2 text-sm text-warning-fg" data-testid="produto-do-precificaeva">
              {t("Este item vem do PrecificaEva. Nome, categoria, preço, custo e situação são atualizados de lá a cada hora: o que mudar aqui volta ao valor do PrecificaEva. Para mudar o preço, altere no PrecificaEva.")}
            </p>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              {t("Código")}
              <input
                value={rascunho.codigo}
                onChange={(e) => setRascunho({ ...rascunho, codigo: e.target.value })}
                className="mt-1 h-9 w-full rounded-md border px-3"
                data-testid="produto-codigo"
              />
            </label>
            <label className="text-sm">
              {t("Nome")}
              <input
                value={rascunho.nome}
                onChange={(e) => setRascunho({ ...rascunho, nome: e.target.value })}
                className="mt-1 h-9 w-full rounded-md border px-3"
                data-testid="produto-nome"
              />
            </label>
            <label className="text-sm">
              {t("Marca")}
              <input
                value={rascunho.marca}
                onChange={(e) => setRascunho({ ...rascunho, marca: e.target.value })}
                className="mt-1 h-9 w-full rounded-md border px-3"
              />
            </label>
            <label className="text-sm">
              {t("Categoria")}
              <input
                value={rascunho.categoria}
                onChange={(e) => setRascunho({ ...rascunho, categoria: e.target.value })}
                className="mt-1 h-9 w-full rounded-md border px-3"
              />
            </label>
            <label className="text-sm">
              {t("Preço de venda")}
              <input
                value={rascunho.preco}
                disabled={editando?.origem === "precificaeva"}
                onChange={(e) => setRascunho({ ...rascunho, preco: e.target.value })}
                placeholder="5.499,00"
                className="mt-1 h-9 w-full rounded-md border px-3"
                data-testid="produto-preco"
              />
            </label>
            <label className="text-sm">
              {t("Custo")} <span className="text-muted-foreground">{t("(opcional)")}</span>
              <input
                value={rascunho.custo}
                disabled={editando?.origem === "precificaeva"}
                onChange={(e) => setRascunho({ ...rascunho, custo: e.target.value })}
                placeholder="4.100,00"
                className="mt-1 h-9 w-full rounded-md border px-3"
              />
              <span className="mt-1 block text-xs text-muted-foreground">
                {t("Serve para o atendente saber até onde pode negociar. Não aparece para o cliente.")}
              </span>
            </label>
          </div>

          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={rascunho.controla_estoque}
              onChange={(e) => setRascunho({ ...rascunho, controla_estoque: e.target.checked })}
              data-testid="produto-controla-estoque"
            />
            {t("Controlar estoque deste produto")}
          </label>
          {rascunho.controla_estoque ? (
            <label className="mt-2 block text-sm">
              {t("Quantidade")}
              <input
                value={rascunho.quantidade}
                onChange={(e) => setRascunho({ ...rascunho, quantidade: e.target.value })}
                className="mt-1 h-9 w-32 rounded-md border px-3"
              />
            </label>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              {t(
                "Sem controle de estoque, este produto sempre aparece como disponível para o atendente — é o certo para item sob encomenda ou fracionado.",
              )}
            </p>
          )}

          <div className="mt-4">
            <Button onClick={salvar} disabled={salvando} data-testid="salvar-produto">
              {t(salvando ? "Salvando…" : editando ? "Salvar alterações" : "Salvar produto")}
            </Button>
          </div>
        </div>
      ) : null}

      {erroDeLeitura ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-text-muted" data-testid="produtos-erro">
          {t("Não foi possível carregar os produtos. Recarregue a página.")}
        </div>
      ) : filtrados.length === 0 && busca.trim() ? (
        // Busca sem resultado não é catálogo vazio.
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-text-muted" data-testid="produtos-sem-resultado">
          {t("Nenhum produto com essa busca.")}
        </div>
      ) : filtrados.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center" data-testid="produtos-vazio">
          <p className="font-medium">{textos.vazio}</p>
          <p className="mt-1 text-sm text-muted-foreground">{textos.vazioDica}</p>
        </div>
      ) : (
        <ul className="divide-y rounded-lg border" data-testid="lista-produtos">
          {filtrados.map((p) => (
            <li key={p.id} className="flex items-center gap-4 p-3" data-testid={`produto-${p.codigo}`}>
              <div className="min-w-0 flex-1">
                <p className={`truncate font-medium ${p.ativo ? "" : "text-muted-foreground line-through"}`}>
                  {p.nome}
                </p>
                <p className="text-xs text-muted-foreground">
                  {p.codigo}
                  {p.marca ? ` · ${p.marca}` : ""}
                  {p.controla_estoque
                    ? ` · ${p.quantidade} ${t("em estoque")}`
                    : ` · ${t("sem controle de estoque")}`}
                  {p.origem === "precificaeva" ? ` · ${t("preço do PrecificaEva")}` : ""}
                </p>
              </div>
              <span className="shrink-0 tabular-nums font-medium">
                {formatCents(p.preco_cents, p.moeda)}
              </span>
              {podeEditar ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => abrirEdicao(p)}
                  data-testid={`editar-${p.codigo}`}
                >
                  {t("Editar")}
                </Button>
              ) : null}
              {podeEditar ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    // Desativar tira o item do que o assistente de IA oferece:
                    // pede confirmação. Reativar é seguro e vai direto.
                    if (p.ativo && !window.confirm(t("Desativar este produto? O assistente de IA deixa de oferecê-lo."))) return;
                    void alternarAtivo(p);
                  }}
                  data-testid={`alternar-${p.codigo}`}
                >
                  {t(p.ativo ? "Desativar" : "Reativar")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
