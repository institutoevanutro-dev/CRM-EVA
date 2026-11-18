"use client";
/**
 * Os cinco campos do ritmo, com o erro embaixo de cada um.
 *
 * Um componente só para as três telas que pedem ritmo — campanha nova, ritmo da
 * campanha em pé e padrões da organização —, validado pelo MESMO schema do
 * servidor (`ritmoCompletoSchema`). Auditoria de 17/11/2026, item 18: só "Enviar
 * a partir das" preenchido dava "Erro interno", e intervalo 0 dava "Dados
 * inválidos" sem dizer qual campo. A tela agora diz antes de mandar.
 */
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { ritmoCompletoSchema } from "@/lib/campanhas/schemas";

export const CAMPOS_DO_RITMO = [
  "intervalo_segundos",
  "teto_diario",
  "teto_horario",
  "janela_inicio_hora",
  "janela_fim_hora",
] as const;

export type CampoDoRitmo = (typeof CAMPOS_DO_RITMO)[number];

/** O que está nos campos, como a pessoa digitou. Vazio = herda o número. */
export type ValoresDoRitmo = Record<CampoDoRitmo, string>;

export const RITMO_EM_BRANCO: ValoresDoRitmo = {
  intervalo_segundos: "",
  teto_diario: "",
  teto_horario: "",
  janela_inicio_hora: "",
  janela_fim_hora: "",
};

const ROTULO: Record<CampoDoRitmo, string> = {
  intervalo_segundos: "Intervalo mínimo entre mensagens (segundos)",
  teto_diario: "Máximo por dia",
  teto_horario: "Máximo por hora",
  janela_inicio_hora: "Enviar só a partir das (hora)",
  janela_fim_hora: "Parar de enviar às (hora)",
};

/** `null` vira campo vazio — e campo vazio volta a ser `null`, que é "herda o número". */
export function ritmoNosCampos(
  origem: Partial<Record<CampoDoRitmo, number | null | undefined>>,
): ValoresDoRitmo {
  const campos = { ...RITMO_EM_BRANCO };
  for (const campo of CAMPOS_DO_RITMO) {
    const v = origem[campo];
    campos[campo] = v === null || v === undefined ? "" : String(v);
  }
  return campos;
}

/** O que vai para a API. Texto que não é número vira `NaN`, e o schema recusa. */
export function ritmoParaEnviar(valores: ValoresDoRitmo): Record<CampoDoRitmo, number | null> {
  const saida = {} as Record<CampoDoRitmo, number | null>;
  for (const campo of CAMPOS_DO_RITMO) {
    const limpo = valores[campo].trim();
    saida[campo] = limpo === "" ? null : Number(limpo);
  }
  return saida;
}

/** Um erro por campo, na frase que a tela mostra. Vazio = pode salvar. */
export function errosDoRitmo(valores: ValoresDoRitmo): Partial<Record<CampoDoRitmo, string>> {
  const r = ritmoCompletoSchema.safeParse(ritmoParaEnviar(valores));
  if (r.success) return {};
  const erros: Partial<Record<CampoDoRitmo, string>> = {};
  for (const problema of r.error.issues) {
    const campo = problema.path[0] as CampoDoRitmo;
    erros[campo] ??= problema.message;
  }
  return erros;
}

export function CamposDeRitmo({
  prefixo,
  valores,
  onChange,
}: {
  /** Prefixo dos `id`s: a tela de detalhe e a de padrões podem conviver no teste. */
  prefixo: string;
  valores: ValoresDoRitmo;
  onChange: (valores: ValoresDoRitmo) => void;
}) {
  const t = useT();
  const erros = errosDoRitmo(valores);

  const campo = (nome: CampoDoRitmo, faixa: { min: number; max: number }) => {
    const id = `${prefixo}-${nome}`;
    const erro = erros[nome];
    return (
      <div className="space-y-2">
        <Label htmlFor={id}>{t(ROTULO[nome])}</Label>
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={faixa.min}
          max={faixa.max}
          value={valores[nome]}
          aria-invalid={erro ? true : undefined}
          aria-describedby={erro ? `${id}-erro` : undefined}
          onChange={(e) => onChange({ ...valores, [nome]: e.target.value })}
        />
        {erro && (
          <p id={`${id}-erro`} className="text-sm text-error-fg">
            {t(erro)}
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {campo("intervalo_segundos", { min: 1, max: 86_400 })}
      {campo("teto_diario", { min: 1, max: 10_000 })}
      {campo("teto_horario", { min: 1, max: 10_000 })}
      <div className="hidden sm:block" />
      {campo("janela_inicio_hora", { min: 0, max: 23 })}
      {campo("janela_fim_hora", { min: 1, max: 24 })}
    </div>
  );
}
