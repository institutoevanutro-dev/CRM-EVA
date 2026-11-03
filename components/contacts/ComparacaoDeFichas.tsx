"use client";
/**
 * ComparacaoDeFichas — as duas fichas lado a lado, linha a linha, para quem vai
 * juntar decidir com os dados na frente (porte do #3640).
 *
 * Em tela larga é uma grade de três colunas (rótulo + uma por ficha). Em tela
 * estreita vira uma coluna só, e cada valor leva o nome da ficha na frente:
 * nada rola na horizontal.
 *
 * As linhas são as da clínica: o que prova a identidade (nascimento, CPF
 * cadastrado — nunca o número) e o que a junção não leva da ficha absorvida ou
 * aperta em quem fica (CPF, endereço, prontuário, pedido de parar, IA).
 * "igual nas duas" só vale nas linhas de texto: dois "Cadastrado" no CPF são
 * dois CPFs diferentes (índice único), e duas "Vinculada" são dois pacientes.
 *
 * O "Este fica" só aparece com `onEscolherPrincipal`: sem ele a comparação é só
 * leitura, sem controle que não faça nada.
 */
import { format } from "date-fns";
import { useT } from "@/hooks/i18n/useT";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { origemDoContato } from "@/lib/inicio/paineis";
import { useCompararFichas, type FichaParaComparar } from "@/hooks/contacts/useCompararFichas";

interface Props {
  ids: [string, string];
  principalId?: string | null;
  onEscolherPrincipal?: (id: string) => void;
}

/**
 * As origens reais de `contacts.source` no fork. Lida só por
 * `t(ROTULO_DA_ORIGEM_DA_FICHA[source])`, a forma que a cerca do espanhol
 * resolve. A origem do prontuário vem de `origemDoContato`, o lugar que já
 * conhece o valor gravado no banco. Valor desconhecido sai cru.
 */
const ROTULO_DA_ORIGEM_DA_FICHA = {
  manual: "Manual",
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  import_csv: "Importado (CSV)",
  meta_ads: "Anúncio da Meta",
  google_ads: "Anúncio do Google",
  webhook: "Formulário ou site",
  nuvemshop: "Nuvemshop",
} as const;

function ehOrigemConhecida(source: string): source is keyof typeof ROTULO_DA_ORIGEM_DA_FICHA {
  return Object.prototype.hasOwnProperty.call(ROTULO_DA_ORIGEM_DA_FICHA, source);
}

function rotuloDaOrigem(source: string, t: (texto: string) => string): string {
  if (origemDoContato(source) === "prontuario") return t("Prontuário");
  return ehOrigemConhecida(source) ? t(ROTULO_DA_ORIGEM_DA_FICHA[source]) : source;
}

interface Linha {
  rotulo: string;
  valores: [string | null, string | null];
  /** Só as linhas de texto marcam "igual nas duas". */
  comparaTexto: boolean;
}

function linhasDaComparacao(
  a: FichaParaComparar,
  b: FichaParaComparar,
  t: (texto: string) => string,
  data: (iso: string, padrao: string) => string,
): Linha[] {
  const duas = <V,>(f: (x: FichaParaComparar) => V): [V, V] => [f(a), f(b)];
  const doisCpfs = a.cpf_available && b.cpf_available;
  return [
    { rotulo: t("Nome"), valores: duas((f) => rotuloDoContato(f, t)), comparaTexto: true },
    {
      rotulo: t("Telefone"),
      valores: duas((f) => (f.phone_number ? phoneForDisplay(f.phone_number) : null)),
      comparaTexto: true,
    },
    { rotulo: t("E-mail"), valores: duas((f) => f.email), comparaTexto: true },
    {
      rotulo: t("Data de nascimento"),
      valores: duas((f) => (f.birthdate ? format(new Date(`${f.birthdate}T12:00:00`), "dd/MM/yyyy") : null)),
      comparaTexto: true,
    },
    {
      rotulo: "CPF",
      valores: duas((f) =>
        f.cpf_available ? (doisCpfs ? t("Cadastrado (CPFs diferentes)") : t("Cadastrado")) : null,
      ),
      comparaTexto: false,
    },
    { rotulo: t("Endereço"), valores: duas((f) => f.endereco), comparaTexto: true },
    {
      rotulo: t("Prontuário"),
      valores: duas((f) => (f.prontuario_linked ? t("Vinculada") : null)),
      comparaTexto: false,
    },
    {
      rotulo: t("Pediu para não receber mensagens"),
      valores: duas((f) => (f.is_blocked ? t("Sim") : null)),
      comparaTexto: false,
    },
    {
      rotulo: t("IA neste contato"),
      valores: duas((f) =>
        f.ai_opt_out
          ? t("Sempre atendimento humano")
          : f.force_human
            ? t("Com a equipe (IA pausada)")
            : f.inbox_hidden_at
              ? t("Oculto do Inbox")
              : t("Ativa"),
      ),
      comparaTexto: false,
    },
    {
      rotulo: t("Origem da ficha"),
      valores: duas((f) => (f.source === null ? null : rotuloDaOrigem(f.source, t))),
      comparaTexto: false,
    },
    { rotulo: t("Criada em"), valores: duas((f) => data(f.created_at, "dd/MM/yyyy")), comparaTexto: false },
    {
      rotulo: t("Última atividade"),
      valores: duas((f) => (f.last_activity_at ? data(f.last_activity_at, "dd/MM/yyyy HH:mm") : null)),
      comparaTexto: false,
    },
    { rotulo: t("Conversas"), valores: duas((f) => String(f.conversas)), comparaTexto: false },
    { rotulo: t("Negócios"), valores: duas((f) => String(f.negocios)), comparaTexto: false },
  ];
}

export function ComparacaoDeFichas({ ids, principalId, onEscolherPrincipal }: Props) {
  const t = useT();
  const localeDaData = useLocaleDeData();
  const q = useCompararFichas(ids);

  // Com dado na mão, ele fica na tela: a recarga que falha depois de uma fusão
  // (a lápide some da comparação) não troca a grade por um erro piscando.
  if (!q.data) {
    if (q.isError) {
      return (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-error-fg">
          <span>{t("Não foi possível carregar as fichas.")}</span>
          <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
            {t("Tentar de novo")}
          </Button>
        </div>
      );
    }
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const fichas = q.data.data.contatos;
  if (fichas.length !== 2) return null;
  const [fa, fb] = fichas as [FichaParaComparar, FichaParaComparar];
  const nomes: [string, string] = [rotuloDoContato(fa, t), rotuloDoContato(fb, t)];
  const linhas = linhasDaComparacao(fa, fb, t, (iso, padrao) => format(new Date(iso), padrao, { locale: localeDaData }));
  const grupoDoRadio = `principal-comparacao-${fa.id}-${fb.id}`;

  return (
    <div
      className="grid grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-[8.5rem_minmax(0,1fr)_minmax(0,1fr)]"
      data-testid="comparacao-de-fichas"
    >
      <div className="hidden sm:block" />
      {[fa, fb].map((f, i) => {
        const escolhida = principalId === f.id;
        return (
          <div key={f.id} className="min-w-0 border-b border-border pb-2">
            {onEscolherPrincipal ? (
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name={grupoDoRadio}
                  className="mt-1"
                  checked={escolhida}
                  onChange={() => onEscolherPrincipal(f.id)}
                  aria-label={t("Manter este cadastro")}
                />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{nomes[i]}</span>
                  <span className="block text-xs font-medium text-primary">{escolhida ? t("Este fica") : ""}</span>
                </span>
              </label>
            ) : (
              <span className="block truncate font-medium">{nomes[i]}</span>
            )}
          </div>
        );
      })}

      {linhas.map((linha) => {
        const [va, vb] = linha.valores;
        const igual = linha.comparaTexto && va !== null && va === vb;
        return (
          <div key={linha.rotulo} className="contents">
            <div className="pt-2 text-xs uppercase text-muted-foreground">
              {linha.rotulo}
              {igual ? <span className="block normal-case">{t("igual nas duas")}</span> : null}
            </div>
            {linha.valores.map((valor, i) => (
              <div key={i} className={`min-w-0 rounded-md px-2 py-1.5 text-sm ${igual ? "bg-muted/60" : ""}`}>
                {/* Em tela estreita o valor perde a coluna: o nome da ficha volta na frente. */}
                <span className="mb-0.5 block truncate text-xs text-muted-foreground sm:hidden">{nomes[i]}</span>
                {valor === null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <span className="block whitespace-pre-wrap break-words">{valor}</span>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
