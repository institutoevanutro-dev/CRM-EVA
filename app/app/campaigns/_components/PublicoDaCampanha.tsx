"use client";
/**
 * O PÚBLICO da campanha — um componente para a tela de criar e a de editar.
 *
 * ═══ Por que um componente só ═══
 *
 * Eram duas cópias do mesmo formulário, e elas divergiram: a de criar ganhou
 * "com negócio no funil / na etapa" e a de editar não. Salvar a edição apagava
 * esse critério do público — a campanha passava a pegar gente que nunca esteve
 * no recorte (auditoria de 17/11/2026, item 13, P0). Com um componente, o campo
 * novo entra nas duas telas ou em nenhuma.
 *
 * ═══ O filtro que sai daqui é o INTEIRO ═══
 *
 * `filtroDoPublico` parte do filtro gravado e troca só o que esta tela mostra:
 * um critério que a tela não exibe (gravado pela API) volta como estava. O
 * servidor também mescla (`mesclarFiltroDeAudiencia`) — duas trancas.
 *
 * ═══ A contagem não sobrevive ao filtro que a gerou ═══
 *
 * "Ver quantas pessoas" mostrava o número antigo depois que o filtro mudava
 * (item 21). O número agora só aparece se o filtro e as variáveis do texto forem
 * os MESMOS da contagem — derivado, sem efeito para "limpar".
 */
import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { PontoDaEtiqueta } from "@/components/tags/PontoDaEtiqueta";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useContactTagVocabulary } from "@/hooks/contacts/useContactTagVocabulary";
import { usePreviaDaAudiencia } from "@/hooks/campanhas/useCampanhas";
import { useEtapas, useFunis } from "@/hooks/campanhas/useDestinoDaCampanha";
import { useT } from "@/hooks/i18n/useT";
import { filtroDeAudienciaSchema } from "@/lib/campanhas/audiencia";
import { variaveisUsadas } from "@/lib/campanhas/renderizador";
import { opcoesDoFiltroDeEtiquetas } from "@/lib/contacts/etiquetas";
import { CaretDown } from "@/lib/ui/icons";

/** O que a tela mostra, como a pessoa escolheu. Listas ficam listas: o que veio gravado volta inteiro. */
export interface CamposDoPublico {
  com_alguma_tag: string[];
  sem_tags: string[];
  sem_interacao_ha_dias: string;
  funis: string[];
  etapas: string[];
  limite: string;
}

export const PUBLICO_EM_BRANCO: CamposDoPublico = {
  com_alguma_tag: [],
  sem_tags: [],
  sem_interacao_ha_dias: "",
  funis: [],
  etapas: [],
  limite: "100",
};

/** O filtro gravado virando campos da tela (a edição começa daqui). */
export function publicoDoFiltro(filtro: Record<string, unknown> | null | undefined): CamposDoPublico {
  const f = filtro ?? {};
  const lista = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    com_alguma_tag: lista(f.com_alguma_tag),
    sem_tags: lista(f.sem_tags),
    sem_interacao_ha_dias: f.sem_interacao_ha_dias == null ? "" : String(f.sem_interacao_ha_dias),
    funis: lista(f.funis),
    etapas: lista(f.etapas),
    limite: f.limite == null ? "100" : String(f.limite),
  };
}

/** O filtro INTEIRO que vai para a API: o gravado, com o que a tela mostra por cima. */
export function filtroDoPublico(
  campos: CamposDoPublico,
  gravado: Record<string, unknown> = {},
): Record<string, unknown> {
  const numero = (v: string, vazio: number | null) => (v.trim() === "" ? vazio : Number(v));
  return {
    ...gravado,
    com_alguma_tag: campos.com_alguma_tag,
    sem_tags: campos.sem_tags,
    sem_interacao_ha_dias: numero(campos.sem_interacao_ha_dias, null),
    funis: campos.funis,
    etapas: campos.etapas,
    limite: numero(campos.limite, 100),
  };
}

/** A mesma régua do servidor: pelo menos um critério, e números na faixa. */
export function conferirPublico(filtro: Record<string, unknown>): {
  valido: boolean;
  erros: Partial<Record<"sem_interacao_ha_dias" | "limite", string>>;
} {
  const r = filtroDeAudienciaSchema.safeParse(filtro);
  if (r.success) return { valido: true, erros: {} };
  const erros: Partial<Record<"sem_interacao_ha_dias" | "limite", string>> = {};
  for (const problema of r.error.issues) {
    const campo = problema.path[0];
    if (campo === "sem_interacao_ha_dias" || campo === "limite") erros[campo] ??= problema.message;
  }
  return { valido: false, erros };
}

const chaveDaContagem = (filtro: unknown, texto: string) =>
  JSON.stringify([filtro, variaveisUsadas(texto).sort()]);

const CLASSE_DO_SELECT = "h-9 w-full rounded-md border border-border bg-surface px-2 text-sm";

export function PublicoDaCampanha({
  campos,
  onChange,
  gravado,
  texto,
  campanhaId,
}: {
  campos: CamposDoPublico;
  onChange: (campos: CamposDoPublico) => void;
  /** O filtro como está no banco (edição). Na criação, nada. */
  gravado?: Record<string, unknown>;
  /** O texto da mensagem: quem não tem o dado que ela usa fica de fora da conta. */
  texto: string;
  /** A campanha em edição — fica fora da conta de "já em outra campanha". */
  campanhaId?: string;
}) {
  const t = useT();
  const funis = useFunis();
  const etapas = useEtapas(campos.funis[0] ?? null);
  const previa = usePreviaDaAudiencia();

  const filtro = filtroDoPublico(campos, gravado);
  const { valido, erros } = conferirPublico(filtro);
  const contagem =
    previa.data && previa.variables && chaveDaContagem(previa.variables.audience_filter, previa.variables.message_body) === chaveDaContagem(filtro, texto)
      ? previa.data
      : null;

  const mudar = (parcial: Partial<CamposDoPublico>) => onChange({ ...campos, ...parcial });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t("Escolha pelo menos um critério — uma lista sem recorte ninguém confere antes de apertar.")}
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <SeletorDeEtiquetas
          id="pub-com-tags"
          rotulo={t("Com alguma destas etiquetas")}
          escolhidas={campos.com_alguma_tag}
          onChange={(com_alguma_tag) => mudar({ com_alguma_tag })}
        />
        <SeletorDeEtiquetas
          id="pub-sem-tags"
          rotulo={t("Sem nenhuma destas etiquetas")}
          escolhidas={campos.sem_tags}
          onChange={(sem_tags) => mudar({ sem_tags })}
        />
        <div className="space-y-2">
          <Label htmlFor="pub-funil">{t("Com negócio no funil")}</Label>
          <select
            id="pub-funil"
            className={CLASSE_DO_SELECT}
            value={campos.funis[0] ?? ""}
            onChange={(e) => mudar({ funis: e.target.value ? [e.target.value] : [], etapas: [] })}
          >
            <option value="">{t("Qualquer um")}</option>
            {(funis.data ?? []).map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="pub-etapa">{t("Com negócio na etapa")}</Label>
          <select
            id="pub-etapa"
            className={CLASSE_DO_SELECT}
            value={campos.etapas[0] ?? ""}
            onChange={(e) => mudar({ etapas: e.target.value ? [e.target.value] : [] })}
            disabled={campos.funis.length === 0}
          >
            <option value="">{t("Qualquer etapa")}</option>
            {(etapas.data ?? []).map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </div>
        <CampoNumerico
          id="pub-silencio"
          rotulo={t("Sem falar com a gente há (dias)")}
          valor={campos.sem_interacao_ha_dias}
          erro={erros.sem_interacao_ha_dias}
          faixa={{ min: 1, max: 3650 }}
          onChange={(sem_interacao_ha_dias) => mudar({ sem_interacao_ha_dias })}
        />
        <CampoNumerico
          id="pub-limite"
          rotulo={t("Máximo de contatos nesta campanha")}
          valor={campos.limite}
          erro={erros.limite}
          faixa={{ min: 1, max: 5000 }}
          onChange={(limite) => mudar({ limite })}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={!valido || previa.isPending}
          onClick={() =>
            previa.mutate({ audience_filter: filtro, message_body: texto, ...(campanhaId ? { campaign_id: campanhaId } : {}) })
          }
        >
          {previa.isPending ? t("Contando…") : t("Ver quantas pessoas")}
        </Button>
        {contagem && (
          <p className="text-sm" role="status">
            <strong>{contagem.elegiveis}</strong> {t("podem receber")}
            {contagem.excluidos > 0 ? ` · ${contagem.excluidos} ${t("ficam de fora")}` : ""}
          </p>
        )}
      </div>
      {contagem && contagem.excluidos > 0 && (
        <ul className="space-y-1 text-sm text-muted-foreground">
          {Object.entries(contagem.motivos).map(([motivo, quantos]) => (
            <li key={motivo}>
              {quantos} — {t(contagem.legenda[motivo] ?? motivo)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CampoNumerico({
  id,
  rotulo,
  valor,
  erro,
  faixa,
  onChange,
}: {
  id: string;
  rotulo: string;
  valor: string;
  erro?: string;
  faixa: { min: number; max: number };
  onChange: (valor: string) => void;
}) {
  const t = useT();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{rotulo}</Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={faixa.min}
        max={faixa.max}
        value={valor}
        aria-invalid={erro ? true : undefined}
        aria-describedby={erro ? `${id}-erro` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {erro && (
        <p id={`${id}-erro`} className="text-sm text-error-fg">
          {t(erro)}
        </p>
      )}
    </div>
  );
}

/**
 * Etiquetas ESCOLHIDAS das que os contatos têm, não digitadas.
 *
 * Era um campo de texto "separe por vírgula": um erro de digitação ("retrono")
 * virava um público vazio sem aviso (item 26). As opções são o vocabulário de
 * etiquetas da organização, mais as já escolhidas — uma etiqueta gravada que
 * sumiu dos contatos continua visível para poder ser tirada.
 */
function SeletorDeEtiquetas({
  id,
  rotulo,
  escolhidas,
  onChange,
}: {
  id: string;
  rotulo: string;
  escolhidas: string[];
  onChange: (etiquetas: string[]) => void;
}) {
  const t = useT();
  const org = useActiveOrg();
  const vocabulario = useContactTagVocabulary(org?.orgId ?? null);
  const opcoes = opcoesDoFiltroDeEtiquetas({ vocabulario: vocabulario.data, selecionadas: escolhidas });

  return (
    <div className="space-y-2">
      <Label id={`${id}-rotulo`} htmlFor={id}>
        {rotulo}
      </Label>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            className="w-full justify-between font-normal"
            aria-labelledby={`${id}-rotulo ${id}-resumo`}
          >
            <span id={`${id}-resumo`} className="flex min-w-0 items-center gap-2 truncate">
              {escolhidas.length === 0 ? (
                <span className="text-muted-foreground">{t("Escolher etiquetas")}</span>
              ) : (
                escolhidas.join(", ")
              )}
            </span>
            <CaretDown size={14} aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
          {opcoes.length === 0 && (
            <DropdownMenuItem disabled>{t("Nenhuma etiqueta nos contatos ainda.")}</DropdownMenuItem>
          )}
          {/* Marca e NÃO fecha: escolher a segunda etiqueta não pode exigir reabrir o menu. */}
          {opcoes.map((etiqueta) => (
            <DropdownMenuCheckboxItem
              key={etiqueta}
              checked={escolhidas.includes(etiqueta)}
              onCheckedChange={() =>
                onChange(
                  escolhidas.includes(etiqueta)
                    ? escolhidas.filter((e) => e !== etiqueta)
                    : [...escolhidas, etiqueta],
                )
              }
              onSelect={(e) => e.preventDefault()}
            >
              <PontoDaEtiqueta tag={etiqueta} className="mr-2" />
              {etiqueta}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
