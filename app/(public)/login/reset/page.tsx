import Link from "next/link";
import { cookies } from "next/headers";

import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";
import { COOKIE_TROCA_DE_SENHA, lerMarcaDaTroca } from "@/lib/auth/troca-de-senha";
import { createClient } from "@/lib/supabase/server";
import { idiomaDoVisitante } from "@/lib/i18n/idiomaAnonimo";
import { traduzir } from "@/lib/i18n/dicionario";

export const metadata = { title: "Nova senha" };

export default async function ResetPasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const idioma = await idiomaDoVisitante(
    (user?.user_metadata?.locale as string | undefined) ?? null,
  );
  const t = (texto: string) => traduzir(texto, idioma);
  // A troca vale só para a conta do link verificado (`lib/auth/troca-de-senha.ts`).
  // `user` pode faltar aqui: a 1ª carga vem do clique no webmail, e o cookie de
  // sessão (Strict) não viaja nela. Se veio, tem de ser a mesma conta.
  const marca = lerMarcaDaTroca((await cookies()).get(COOKIE_TROCA_DE_SENHA)?.value);
  const liberada = marca !== null && (!user || user.id === marca.userId);

  if (!liberada) {
    return (
      <div className="space-y-6">
        <div className="space-y-1.5 text-center">
          <h1 className="titulo-tela">{t("Definir nova senha")}</h1>
        </div>
        <div
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {t("Este link não vale mais. Peça um novo em Esqueci minha senha.")}
        </div>
        <p className="text-center text-sm">
          <Link
            href="/login/forgot"
            className="text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            {t("Esqueci minha senha")}
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1.5 text-center">
        <h1 className="titulo-tela">{t("Definir nova senha")}</h1>
        {/* De quem é a conta: a pessoa confere antes de trocar. */}
        <p className="text-sm text-muted-foreground">
          {t("Nova senha para")} <strong className="font-medium text-foreground">{marca.email}</strong>
        </p>
      </div>
      <ResetPasswordForm />
    </div>
  );
}
