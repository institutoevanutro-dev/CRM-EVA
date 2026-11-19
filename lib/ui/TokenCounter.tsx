"use client";
import * as React from "react";
import { encode } from "gpt-tokenizer";

import { useT } from "@/hooks/i18n/useT";

interface Props {
  text: string;
  contextWindow?: number | null;
  className?: string;
}

export function TokenCounter({ text, contextWindow, className }: Props) {
  const t = useT();
  const [count, setCount] = React.useState<number | null>(null);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      try {
        setCount(encode(text ?? "").length);
      } catch {
        setCount(null);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [text]);

  // "~21 tokens" era jargão sempre à vista. O contador de caracteres ao lado já
  // diz o tamanho; este só aparece quando o texto chega perto do que o modelo lê.
  const ratio = count !== null && contextWindow && contextWindow > 0 ? count / contextWindow : null;
  if (ratio === null || ratio <= 0.8) return null;
  const danger = ratio > 1;

  return (
    <span
      className={`${danger ? "text-destructive" : "text-warning-fg"} ${className ?? ""}`}
      aria-live="polite"
    >
      {danger ? t("Maior do que o modelo consegue ler") : t("Perto do limite do que o modelo lê")}
    </span>
  );
}
