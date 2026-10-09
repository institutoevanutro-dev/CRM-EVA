import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { MfaForm } from "@/components/auth/MfaForm";
import { idiomaDoVisitante } from "@/lib/i18n/idiomaAnonimo";
import { traduzir } from "@/lib/i18n/dicionario";

export const metadata = { title: "Verificação em duas etapas" };

export default async function MfaChallengePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Leitura que FALHOU não é "sem fator": o `listFactors()` devolve
  // `{ data: null, error }` em vez de lançar. Devolver para `/app` nesse caso
  // faria esta página e o `app/app/layout.tsx` (que manda para cá quem tem fator
  // e sessão `aal1`) se devolverem uma à outra enquanto a leitura oscila. Na
  // dúvida, fica o formulário: quem não tem fator só não consegue confirmar.
  const { data: factorsData, error: falhaAoLerFatores } = await supabase.auth.mfa.listFactors();
  const hasVerified = !!factorsData?.totp?.some((f) => f.status === "verified");
  if (!falhaAoLerFatores && !hasVerified) redirect("/app");

  const idioma = await idiomaDoVisitante(
    (user.user_metadata?.locale as string | undefined) ?? null,
  );
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <div className="space-y-6">
      <div className="space-y-1.5 text-center">
        <h1 className="text-[2rem] leading-tight">{t("Verificação em duas etapas")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Digite o código de 6 dígitos do seu autenticador.")}
        </p>
      </div>
      <MfaForm next={next} />
    </div>
  );
}
