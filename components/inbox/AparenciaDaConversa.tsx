"use client";
import { useId, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useT } from "@/hooks/i18n/useT";
import { salvarAparenciaDaConversa } from "@/app/actions/settings/salvarAparenciaDaConversa";
import {
  ENVIADAS,
  FUNDOS,
  RECEBIDAS,
  estiloDaAparencia,
  type AparenciaDaConversa,
} from "@/lib/inbox/aparencia-da-conversa";
import { Check, Palette } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

type Campo = keyof AparenciaDaConversa;

/**
 * "Aparência da conversa": fundo e cor dos balões, de cada pessoa.
 *
 * A escolha aparece NA HORA (o pai troca o estado antes de gravar) e vai para o
 * perfil em seguida; se a gravação falhar, a tela volta ao que estava e diz por
 * quê — uma cor que some no próximo login sem aviso é pior que não trocar.
 *
 * Cada amostra é desenhada com as MESMAS variáveis do fio da conversa
 * (`data-aparencia-conversa` + `estiloDaAparencia`), então mostra a cor do tema
 * em uso, claro ou escuro, e não uma figura fixa que mentiria num deles.
 * Rádio nativo por baixo: setas, Tab e leitor de tela funcionam sem código.
 */
export function AparenciaDaConversa({
  valor,
  onChange,
}: {
  valor: AparenciaDaConversa;
  onChange: (proximo: AparenciaDaConversa) => void;
}) {
  const t = useT();
  const [salvando, setSalvando] = useState(false);

  const escolher = async <C extends Campo>(campo: C, id: AparenciaDaConversa[C]) => {
    if (valor[campo] === id) return;
    const anterior = valor;
    const proximo = { ...valor, [campo]: id };
    onChange(proximo);
    setSalvando(true);
    try {
      const r = await salvarAparenciaDaConversa(proximo);
      if (!r.ok) throw new Error(r.error);
    } catch {
      onChange(anterior);
      toast.error(t("Não foi possível salvar a aparência. Tente de novo."));
    } finally {
      setSalvando(false);
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="w-11 px-0 lg:w-8"
          aria-label={t("Aparência da conversa")}
          title={t("Aparência da conversa")}
        >
          <Palette size={16} aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(20rem,calc(100vw-2rem))] space-y-4 p-4">
        <div>
          <h3 className="text-sm font-semibold">{t("Aparência da conversa")}</h3>
          <p className="text-xs text-text-muted">
            {t("Só para você, em qualquer computador em que entrar.")}
          </p>
        </div>
        <Grupo
          legenda={t("Fundo")}
          campo="fundo"
          opcoes={FUNDOS}
          valor={valor}
          onEscolher={escolher}
          amostra={(a) => (
            <span
              data-aparencia-conversa=""
              style={estiloDaAparencia(a)}
              className="conversa-fundo block h-10 w-full rounded-md border border-border"
            />
          )}
        />
        <Grupo
          legenda={t("Suas mensagens")}
          campo="enviada"
          opcoes={ENVIADAS}
          valor={valor}
          onEscolher={escolher}
          amostra={(a) => <Balao aparencia={a} lado="enviada" />}
        />
        <Grupo
          legenda={t("Mensagens do cliente")}
          campo="recebida"
          opcoes={RECEBIDAS}
          valor={valor}
          onEscolher={escolher}
          amostra={(a) => <Balao aparencia={a} lado="recebida" />}
        />
        <p role="status" className="min-h-4 text-[11px] text-text-muted">
          {salvando ? t("Salvando…") : ""}
        </p>
      </PopoverContent>
    </Popover>
  );
}

function Balao({ aparencia, lado }: { aparencia: AparenciaDaConversa; lado: "enviada" | "recebida" }) {
  return (
    <span
      data-aparencia-conversa=""
      style={estiloDaAparencia(aparencia)}
      className="conversa-fundo flex h-10 w-full items-center rounded-md border border-border px-1.5"
    >
      <span
        className={cn(
          "block h-5 w-full rounded-lg",
          lado === "enviada"
            ? "bg-(--bolha-enviada-fundo)"
            : "border border-border bg-(--bolha-recebida-fundo)",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "mx-1.5 mt-[7px] block h-1.5 w-3/5 rounded-full opacity-80",
            lado === "enviada" ? "bg-(--bolha-enviada-texto)" : "bg-(--bolha-recebida-texto)",
          )}
        />
      </span>
    </span>
  );
}

function Grupo<C extends Campo>({
  legenda,
  campo,
  opcoes,
  valor,
  onEscolher,
  amostra,
}: {
  legenda: string;
  campo: C;
  opcoes: Record<AparenciaDaConversa[C], { rotulo: string }>;
  valor: AparenciaDaConversa;
  onEscolher: (campo: C, id: AparenciaDaConversa[C]) => void;
  amostra: (a: AparenciaDaConversa) => ReactNode;
}) {
  const t = useT();
  const nome = useId();
  const lista = Object.entries(opcoes) as [AparenciaDaConversa[C], { rotulo: string }][];
  return (
    <fieldset>
      <legend className="mb-1.5 text-xs font-medium">{legenda}</legend>
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${lista.length}, minmax(0, 1fr))` }}>
        {lista.map(([id, o]) => {
          const marcado = valor[campo] === id;
          return (
            <label key={id} className="group relative cursor-pointer">
              <input
                type="radio"
                name={nome}
                value={id}
                checked={marcado}
                onChange={() => onEscolher(campo, id)}
                className="peer sr-only"
              />
              <span
                className={cn(
                  "block rounded-lg p-1 ring-1 ring-border transition-shadow",
                  "peer-focus-visible:ring-2 peer-focus-visible:ring-ring",
                  "group-hover:ring-border-strong",
                  marcado && "ring-2 ring-primary group-hover:ring-primary",
                )}
              >
                {amostra({ ...valor, [campo]: id })}
                <span className="mt-1 flex items-center justify-center gap-1 text-[11px] leading-4">
                  {marcado && <Check size={11} weight="bold" aria-hidden />}
                  {t(o.rotulo)}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
