"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useRouter } from "next/navigation";

import { useT } from "@/hooks/i18n/useT";
import { loginSchema, type LoginInput } from "@/lib/auth/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signInWithPassword } from "@/app/actions/auth/signInWithPassword";
import { AvisoSemResposta, useEnvioComTeto } from "@/components/auth/teto-da-espera";

/**
 * `evalink`: com o login pela Conta ligado, a senha é a porta de reserva da
 * administração (`reservaBloqueia`). Aberta como a principal, ela parecia o
 * caminho da equipe: dois botões verdes "Entrar", o cursor no e-mail, a senha
 * certa recusada e as cinco tentativas gastas (auditoria 17/11, item 47).
 * Vira porta secundária: abaixo de "Entrar com senha (administração)", sem
 * cursor no e-mail, botão sem o verde e recusa que aponta o botão do EvaLink.
 *
 * Visível, e não recolhida como o relatório propunha: o e2e roda com o EvaLink
 * ligado, e ~100 specs entram pela senha — recolher pedia mexer em todas.
 */
export function LoginForm({ next, evalink = false }: { next?: string; evalink?: boolean }) {
  const t = useT();
  const router = useRouter();
  const { pendente: isPending, semResposta, enviar } = useEnvioComTeto();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  const onSubmit = (values: LoginInput) => {
    setServerError(null);
    // Server Action redirects on success — no return value reaches here.
    // On failure, an error discriminator is returned and rendered inline.
    void enviar(() => signInWithPassword(values, next), (res) => {
      if (!res) {
        // Should be unreachable (redirect throws), but guard anyway.
        router.replace(next || "/app");
        return;
      }
      if (res.error === "mfa_required") {
        const params = new URLSearchParams();
        if (next) params.set("next", next);
        if (res.challengeId) params.set("factor", res.challengeId);
        router.replace(`/login/mfa${params.toString() ? `?${params}` : ""}`);
        return;
      }
      if (res.error === "invalid_credentials") {
        // Mesma resposta para senha errada e para quem só entra pelo EvaLink
        // (não revela que a senha estava certa); a segunda frase aponta a porta.
        setServerError(
          evalink
            ? `${t("Email ou senha incorretos.")} ${t("Se você entra pelo EvaLink, use o botão acima.")}`
            : t("Email ou senha incorretos."),
        );
      } else if (res.error === "email_not_confirmed") {
        setServerError(t("Confirme seu e-mail pelo link que enviamos antes de entrar."));
      } else if (res.error === "unavailable") {
        setServerError(t("O servidor de login não respondeu. Tente de novo em instantes."));
      } else if (res.error === "rate_limited") {
        setServerError(t("Muitas tentativas. Aguarde alguns minutos."));
      } else if (res.error === "validation_error") {
        setServerError(t("Dados inválidos. Confira os campos."));
      } else {
        setServerError(t("Erro inesperado. Tente novamente."));
      }
    });
  };

  const formulario = (
    <form method="post" onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          autoFocus={!evalink}
          aria-invalid={errors.email ? true : undefined}
          {...register("email")}
        />
        {errors.email && (
          <p className="text-xs text-destructive">{t(errors.email.message ?? "")}</p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">{t("Senha")}</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          aria-invalid={errors.password ? true : undefined}
          {...register("password")}
        />
        {errors.password && (
          <p className="text-xs text-destructive">{t(errors.password.message ?? "")}</p>
        )}
      </div>
      {serverError && (
        <div
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {serverError}
        </div>
      )}
      {semResposta && <AvisoSemResposta />}
      <Button
        type="submit"
        variant={evalink ? "outline" : "default"}
        className="w-full"
        disabled={isPending}
      >
        {isPending ? t("Entrando...") : t("Entrar")}
      </Button>
    </form>
  );

  if (!evalink) return formulario;

  return (
    <section aria-labelledby="entrar-com-senha" className="space-y-4">
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span aria-hidden className="h-px flex-1 bg-border" />
        <h2 id="entrar-com-senha" className="font-normal">
          {t("Entrar com senha (administração)")}
        </h2>
        <span aria-hidden className="h-px flex-1 bg-border" />
      </div>
      {formulario}
    </section>
  );
}
