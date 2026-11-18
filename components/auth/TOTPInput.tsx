"use client";

import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";

interface TOTPInputProps {
  value: string;
  onChange: (next: string) => void;
  onComplete?: (code: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Visual hint for invalid state. */
  hasError?: boolean;
  className?: string;
}

const LENGTH = 6;

/**
 * 6-digit segmented TOTP input with auto-advance, backspace-to-previous,
 * arrow nav, and paste support. Numeric-only, mobile-friendly.
 */
export function TOTPInput({
  value,
  onChange,
  onComplete,
  disabled,
  autoFocus,
  hasError,
  className,
}: TOTPInputProps) {
  const t = useT();
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const [chars, setChars] = useState<string[]>(() =>
    Array.from({ length: LENGTH }, (_, i) => value[i] ?? ""),
  );

  useEffect(() => {
    setChars(Array.from({ length: LENGTH }, (_, i) => value[i] ?? ""));
  }, [value]);

  useEffect(() => {
    if (autoFocus) inputs.current[0]?.focus();
  }, [autoFocus]);

  const commit = (next: string[]) => {
    setChars(next);
    const joined = next.join("");
    onChange(joined);
    if (joined.length === LENGTH && next.every((c) => c !== "") && onComplete) {
      onComplete(joined);
    }
  };

  /** Preenche a partir do 1º quadradinho, como o colar sempre fez. */
  const espalhar = (digitos: string) => {
    const texto = digitos.slice(0, LENGTH);
    commit(Array.from({ length: LENGTH }, (_, i) => texto[i] ?? ""));
    inputs.current[Math.min(texto.length, LENGTH - 1)]?.focus();
  };

  const handleChange = (i: number, raw: string) => {
    // O preenchimento automático do código (Senhas do iPhone/Mac, SMS) põe o
    // código INTEIRO no 1º quadradinho; pegar só o último dígito perdia os
    // outros cinco (auditoria 17/11, item 51).
    const todos = raw.replace(/\D/g, "");
    if (todos.length >= LENGTH) {
      espalhar(todos);
      return;
    }
    // Strip non-digits, take last char.
    const digit = todos.slice(-1);
    if (!digit && raw.length > 0) return;
    const next = [...chars];
    next[i] = digit;
    commit(next);
    if (digit && i < LENGTH - 1) inputs.current[i + 1]?.focus();
  };

  const handleKeyDown = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace") {
      if (chars[i]) {
        const next = [...chars];
        next[i] = "";
        commit(next);
        return;
      }
      if (i > 0) {
        inputs.current[i - 1]?.focus();
        const next = [...chars];
        next[i - 1] = "";
        commit(next);
      }
    } else if (e.key === "ArrowLeft" && i > 0) {
      e.preventDefault();
      inputs.current[i - 1]?.focus();
    } else if (e.key === "ArrowRight" && i < LENGTH - 1) {
      e.preventDefault();
      inputs.current[i + 1]?.focus();
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text").replace(/\D/g, "");
    if (!text) return;
    e.preventDefault();
    espalhar(text);
  };

  return (
    <div
      className={cn("flex items-center justify-center gap-2", className)}
      role="group"
      aria-label={t("Código de 6 dígitos")}
    >
      {chars.map((c, i) => (
        <input
          key={i}
          ref={(el) => {
            inputs.current[i] = el;
          }}
          type="text"
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          // O 1º aceita o código inteiro: com `maxLength={1}` o navegador pode
          // cortar o preenchimento automático no primeiro dígito.
          maxLength={i === 0 ? LENGTH : 1}
          value={c}
          disabled={disabled}
          aria-invalid={hasError ? true : undefined}
          aria-label={`${t("Dígito")} ${i + 1}`}
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onPaste={handlePaste}
          onFocus={(e) => e.currentTarget.select()}
          className={cn(
            "h-12 w-10 rounded-md border border-input bg-background text-center font-mono text-lg tabular-nums",
            "shadow-sm outline-hidden transition focus:border-ring focus:ring-2 focus:ring-ring/30",
            hasError && "border-destructive focus:ring-destructive/30",
            disabled && "opacity-50",
          )}
        />
      ))}
    </div>
  );
}
