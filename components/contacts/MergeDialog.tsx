"use client";
/**
 * MergeDialog — juntar contatos duplicados, pela tela.
 *
 * Este arquivo era andaime morto: o botão de ação nascia `disabled` e o texto
 * mandava o operador "mesclar via SQL". Ninguém o importava. Agora ele é a
 * porta do recurso: lê `GET /api/v1/contacts/duplicates` e chama
 * `POST /api/v1/contacts/merge`.
 *
 * ─── Por que a escolha do principal é EXPLÍCITA ─────────────────────────────
 * A fusão não tem desfazer. O produto SUGERE um vencedor (`principal_sugerido`
 * — o de atividade mais recente), mas quem decide é quem opera, com o rádio na
 * frente e os dois cadastros lado a lado. Aplicar a sugestão sozinha economiza
 * um clique e cobra o preço de um cadastro errado que ninguém volta atrás.
 *
 * ─── E por que o "Juntar" pergunta antes ────────────────────────────────────
 * Este botão chamava a API DIRETO. Medido pela tela em 2026-09-04: um clique
 * disparava `POST /contacts/merge` em 253 ms, sem nenhum passo intermediário —
 * a única ação sem desfazer do produto era também a única sem porteiro. A
 * EXCLUSÃO de um contato, que é a ação menos grave das duas (some com um
 * cadastro; a fusão reescreve o histórico de dois), já abria um `AlertDialog`
 * em `ContactsTable`. O aviso de irreversibilidade que já existia aqui é
 * parágrafo de leitura: ele informa, mas não intercepta o clique errado — e o
 * rádio fica a poucos pixels do botão, então errar o alvo é barato.
 *
 * A confirmação NOMEIA quem fica e quem é absorvido, em vez de perguntar "tem
 * certeza?": o erro que ela precisa pegar não é "cliquei sem querer", é
 * "escolhi o vencedor errado", e para esse erro só o nome na frente serve.
 *
 * ─── Parecidos (porte do #3640) ────────────────────────────────────────────
 * Par que só tem NOME parecido não prova pessoa repetida: pode ser outra
 * pessoa, alguém da mesma família. Por isso fica fora dos grupos fortes, na
 * seção "Parecidos — confira", que o servidor só manda para gestor. A
 * comparação lado a lado abre sob demanda ("Comparar"), e só depois dela
 * aparecem "Juntar" e "Não são a mesma pessoa" — com ~80 pares, buscar todas
 * as comparações ao abrir a janela seria ~500 consultas e 80 linhas de
 * auditoria. A ficha ligada ao prontuário fica por padrão e não pode ser a
 * absorvida (a rota de fusão recusa o mesmo caso com 409).
 *
 * ─── Vocabulário ───────────────────────────────────────────────────────────
 * Nada aqui conhece nicho. "Contato" é contato em e-commerce, clínica,
 * imobiliária e infoproduto; o `vocabulary` do funil renomeia lead/deal, não
 * pessoa.
 */
import { useState } from "react";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { ComparacaoDeFichas } from "@/components/contacts/ComparacaoDeFichas";
import { ConfirmarJuncao, avisarResultadoDaJuncao } from "@/components/contacts/ConfirmarJuncao";
import { ApiError } from "@/lib/api/types";
import { roleAtLeast } from "@/lib/auth/types";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { avisosDaJuncao, motivoQueImpedeAJuncao, quemFicaPorPadrao } from "@/lib/contacts/juncao";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import {
  useContactDuplicates,
  type GrupoDuplicado,
} from "@/hooks/contacts/useContactDuplicates";
import { useCompararFichas } from "@/hooks/contacts/useCompararFichas";
import { useDispensarParecido } from "@/hooks/contacts/useDispensarParecido";
import { useMergeContacts } from "@/hooks/contacts/useMergeContacts";
import type { MotivoDeDuplicidade } from "@/lib/contacts/duplicados";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

const ROTULO_DO_MOTIVO: Record<MotivoDeDuplicidade, string> = {
  telefone: "mesmo telefone",
  email: "mesmo e-mail",
  telefone_em_conflito: "telefone que o WhatsApp deixou em conflito",
  mesmo_nome_instagram_whatsapp: "mesmo nome no Instagram e no WhatsApp",
  nome_parecido: "nome parecido",
};

function GrupoDeDuplicados({
  grupo,
  onFundido,
}: {
  grupo: GrupoDuplicado;
  onFundido: () => void;
}) {
  const t = useT();
  const merge = useMergeContacts();
  const [principal, setPrincipal] = useState(grupo.principal_sugerido);
  const [confirmando, setConfirmando] = useState(false);

  const secundarios = grupo.contatos.map((c) => c.id).filter((id) => id !== principal);
  const contatoPrincipal = grupo.contatos.find((c) => c.id === principal);
  const nomeDeQuemFica = contatoPrincipal ? rotuloDoContato(contatoPrincipal, t) : "";
  const nomesAbsorvidos = grupo.contatos
    .filter((c) => c.id !== principal)
    .map((c) => rotuloDoContato(c, t))
    .join(", ");

  async function juntar() {
    setConfirmando(false);
    try {
      const res = await merge.mutateAsync({
        primary_contact_id: principal,
        secondary_contact_ids: secundarios,
      });
      avisarResultadoDaJuncao(res.data, t);
      onFundido();
    } catch {
      /* showApiError já falou no toast */
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <p className="mb-2 text-xs text-muted-foreground">
        {t("Agrupados por")}: {grupo.motivos.map((m) => t(ROTULO_DO_MOTIVO[m])).join(", ")}
      </p>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {grupo.contatos.map((c) => (
          <label
            key={c.id}
            className={`flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm ${
              c.id === principal ? "border-primary bg-primary/5" : "border-border bg-card"
            }`}
          >
            <input
              type="radio"
              name={`principal-${grupo.chave}`}
              className="mt-1"
              checked={c.id === principal}
              onChange={() => setPrincipal(c.id)}
            />
            <span className="min-w-0">
              <span className="block truncate font-medium">{rotuloDoContato(c, t)}</span>
              <span className="block truncate text-muted-foreground">{c.email ?? "—"}</span>
              <span className="block truncate text-muted-foreground">
                {c.phone_number ? phoneForDisplay(c.phone_number) : "—"}
              </span>
              {c.id === principal ? (
                <span className="mt-1 block text-xs font-medium text-primary">
                  {t("Este fica")}
                </span>
              ) : (
                <span className="mt-1 block text-xs text-muted-foreground">
                  {t("Será absorvido por quem fica")}
                </span>
              )}
            </span>
          </label>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {t(
            "Conversas, mensagens, negócios e histórico passam para quem fica. O cadastro antigo não é apagado — vira registro de fusão. Não há como desfazer.",
          )}
        </p>
        <Button
          size="sm"
          onClick={() => setConfirmando(true)}
          disabled={merge.isPending || secundarios.length === 0}
        >
          {merge.isPending ? t("Juntando…") : t("Juntar")}
        </Button>
      </div>

      <ConfirmarJuncao
        aberto={confirmando}
        onAbertoChange={setConfirmando}
        nomeDeQuemFica={nomeDeQuemFica}
        nomesAbsorvidos={nomesAbsorvidos}
        pendente={merge.isPending}
        onConfirmar={() => void juntar()}
      />
    </div>
  );
}

/**
 * Um par de nome parecido. A comparação abre sob demanda; depois dela, o gestor
 * junta (mesma confirmação nomeada, com os avisos do que a junção faz) ou diz
 * que não são a mesma pessoa. "Este fica" começa na ficha ligada ao prontuário
 * (ou na que tem CPF) — derivado, não copiado para estado: a escolha da pessoa
 * vence quando existe.
 */
function GrupoParecido({
  grupo,
  onFundido,
  podeJuntar,
}: {
  grupo: GrupoDuplicado;
  onFundido: () => void;
  podeJuntar: boolean;
}) {
  const t = useT();
  const merge = useMergeContacts();
  const dispensar = useDispensarParecido();
  const [comparando, setComparando] = useState(false);
  const [escolhido, setEscolhido] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState(false);

  const ids: [string, string] = [grupo.contatos[0]?.id ?? "", grupo.contatos[1]?.id ?? ""];
  const comparacao = useCompararFichas(comparando ? ids : null);
  const fichas = comparacao.data?.data.contatos ?? [];
  const [fa, fb] = [fichas.find((f) => f.id === ids[0]), fichas.find((f) => f.id === ids[1])];
  const principal = escolhido ?? (fa && fb ? quemFicaPorPadrao(fa, fb, grupo.principal_sugerido) : grupo.principal_sugerido);
  const secundario = ids[0] === principal ? ids[1] : ids[0];
  const fica = fichas.find((f) => f.id === principal);
  const sai = fichas.find((f) => f.id === secundario);
  const impede = fica && sai ? motivoQueImpedeAJuncao(fica, sai, t) : null;
  const avisos = fica && sai ? avisosDaJuncao(fica, sai, t) : [];
  const nomeDeQuemFica = rotuloDoContato(grupo.contatos.find((c) => c.id === principal), t);
  const nomeAbsorvido = rotuloDoContato(grupo.contatos.find((c) => c.id === secundario), t);

  async function juntar() {
    setConfirmando(false);
    try {
      const res = await merge.mutateAsync({ primary_contact_id: principal, secondary_contact_ids: [secundario] });
      avisarResultadoDaJuncao(res.data, t);
      onFundido();
    } catch {
      /* showApiError já falou no toast */
    }
  }

  async function naoSaoAMesma() {
    try {
      await dispensar.mutateAsync(ids);
      toast.success(t("Sugestão dispensada."));
    } catch (err) {
      // Pelo CÓDIGO, não pelo status: 403 também é `mfa_required`.
      if (err instanceof ApiError && err.code === "forbidden_role") toast.warning(t("Só gestor pode dispensar."));
      else showApiError(err);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-3" data-testid="par-parecido">
      <p className="text-xs text-muted-foreground">
        {t("Agrupados por")}: {t(ROTULO_DO_MOTIVO.nome_parecido)}
      </p>

      {comparando ? (
        <ComparacaoDeFichas ids={ids} principalId={principal} onEscolherPrincipal={setEscolhido} />
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {grupo.contatos.map((c) => (
            <div key={c.id} className="min-w-0 rounded-md border border-border bg-card p-3 text-sm">
              <span className="block truncate font-medium">{rotuloDoContato(c, t)}</span>
              <span className="block truncate text-muted-foreground">
                {c.phone_number ? phoneForDisplay(c.phone_number) : "—"}
              </span>
            </div>
          ))}
        </div>
      )}

      {podeJuntar ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {impede ? <p className="mr-auto text-xs text-warning-fg">{impede}</p> : null}
          {!comparando ? (
            <Button size="sm" variant="outline" onClick={() => setComparando(true)}>
              {t("Comparar")}
            </Button>
          ) : fica && sai ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => void naoSaoAMesma()} disabled={dispensar.isPending}>
                {t("Não são a mesma pessoa")}
              </Button>
              <Button size="sm" onClick={() => setConfirmando(true)} disabled={merge.isPending || impede !== null}>
                {merge.isPending ? t("Juntando…") : t("Juntar")}
              </Button>
            </>
          ) : null}
          <ConfirmarJuncao
            aberto={confirmando}
            onAbertoChange={setConfirmando}
            nomeDeQuemFica={nomeDeQuemFica}
            nomesAbsorvidos={nomeAbsorvido}
            pendente={merge.isPending}
            onConfirmar={() => void juntar()}
            avisos={avisos}
          />
        </div>
      ) : null}
    </div>
  );
}

export function MergeDialog({ open, onOpenChange }: Props) {
  const t = useT();
  const q = useContactDuplicates(open);
  // Juntar e "Não são a mesma pessoa" são de gestor (o piso de POST /contacts/merge).
  const podeJuntar = roleAtLeast(useActiveOrg()?.role, "manager");
  const grupos = q.data?.data ?? [];
  const fortes = grupos.filter((g) => !g.motivos.includes("nome_parecido"));
  const parecidos = grupos.filter((g) => g.motivos.includes("nome_parecido"));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Contatos duplicados")}</DialogTitle>
          <DialogDescription>
            {t(
              "A mesma pessoa cadastrada duas vezes. Escolha qual cadastro fica; o outro é absorvido sem perder histórico.",
            )}
          </DialogDescription>
        </DialogHeader>

        {q.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : fortes.length === 0 && parecidos.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t("Nenhum contato duplicado encontrado.")}
          </p>
        ) : (
          <div className="space-y-3">
            {fortes.map((grupo) => (
              <GrupoDeDuplicados
                key={grupo.chave}
                grupo={grupo}
                onFundido={() => void q.refetch()}
              />
            ))}

            {parecidos.length > 0 ? (
              <section data-testid="parecidos-confira" className="space-y-3 border-t border-border pt-4">
                <div>
                  <h3 className="text-sm font-semibold">{t("Parecidos — confira")}</h3>
                  <p className="text-xs text-muted-foreground">
                    {t(
                      "Fichas com nome parecido. Confira os dados lado a lado antes de juntar: pode ser outra pessoa com nome parecido, como alguém da mesma família.",
                    )}
                  </p>
                </div>
                {parecidos.map((grupo) => (
                  <GrupoParecido
                    key={grupo.chave}
                    grupo={grupo}
                    onFundido={() => void q.refetch()}
                    podeJuntar={podeJuntar}
                  />
                ))}
              </section>
            ) : null}
          </div>
        )}

        {/*
          O teto da varredura tem VOZ. Sem esta linha, uma base grande mostraria
          os grupos da primeira leva e o silêncio leria como "acabou" — a mesma
          classe de falha de um instrumento que devolve zero quando está cego.
        */}
        {q.data?.meta?.varreu_tudo === false ? (
          <p className="text-xs text-muted-foreground">
            {t(
              "Mostrando os duplicados entre os contatos mais antigos. Junte estes e reabra para ver os próximos.",
            )}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("Fechar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
