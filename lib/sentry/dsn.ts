/**
 * DSN do Sentry, resolvido em runtime (sem rebuild da imagem).
 *
 *   SENTRY_DSN=<seu-dsn>          → manda os erros pro SEU Sentry
 *   SENTRY_DSN=  (vazio) / off    → telemetria desligada (padrão)
 *
 * Até 2026-09-29 o vazio caía num DSN fixo no código, de um projeto Sentry
 * upstream do qual esta instalação não faz mais parte (achado M5 da auditoria).
 * Instalação nova não manda nada a terceiro sem que quem opera escreva um DSN.
 *
 * Vale para servidor (process.env) e navegador (window.__PUBLIC_ENV__.SENTRY_DSN,
 * injetado em runtime pelo <PublicEnvScript/>). O DSN não é segredo — DSNs do
 * Sentry são públicos por design.
 */
export function resolveSentryDsn(value: string | undefined | null): string | undefined {
  const v = (value ?? "").trim();
  if (!v || ["off", "false", "0"].includes(v.toLowerCase())) return undefined;
  return v;
}
