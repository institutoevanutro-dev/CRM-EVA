import Link from "next/link";
import type { Metadata } from "next";

import { resolverOperador } from "@/lib/legal/operador";
import { createClient } from "@/lib/supabase/server";
import { idiomaDoVisitante } from "@/lib/i18n/idiomaAnonimo";
import { traduzir } from "@/lib/i18n/dicionario";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "CRM Eva — Apresentação" };

export default async function AboutPage() {
  const op = await resolverOperador();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const idioma = await idiomaDoVisitante(
    (user?.user_metadata?.locale as string | undefined) ?? null,
  );
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <>
      <header className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">CRM Eva</h1>
        <p className="text-base text-muted-foreground">
          {t("Organização do atendimento, dos contatos e da agenda da equipe profissional.")}
        </p>
        <p>
          {t("Sistema utilizado exclusivamente pela equipe de")} {op.sistema}{" "}
          {t(
            "para organizar contatos, acompanhar atendimentos e gerenciar compromissos. O acesso aos cadastros e à operação do sistema exige uma conta autorizada.",
          )}
        </p>
        <Button asChild>
          <Link href="/login">{t("Acessar o CRM")}</Link>
        </Button>
      </header>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">{t("Integração opcional com o Google Agenda")}</h2>
        <p>
          {t(
            "O profissional pode conectar sua Conta do Google, mediante autorização, e escolher quais agendas serão usadas para consultar disponibilidade e qual receberá os compromissos do CRM.",
          )}
        </p>
        <p>
          {t(
            "A integração consulta agendas e horários ocupados para evitar conflitos. Ela cria, atualiza e cancela eventos vinculados aos compromissos do CRM na agenda de destino escolhida e reconcilia as alterações desses eventos.",
          )}
        </p>
        <p>
          {t(
            "A conexão pode ser removida pelo CRM ou revogada na Conta do Google. A política de privacidade descreve os dados acessados, sua finalidade, armazenamento, compartilhamento e remoção da conexão.",
          )}
        </p>
      </section>

      {op.dpoEmail && (
        <section className="space-y-3">
          <h2 className="text-xl font-semibold">{t("Contato")}</h2>
          <p>
            {t("Para informações sobre o aplicativo e privacidade:")}{" "}
            <a className="underline underline-offset-2" href={`mailto:${op.dpoEmail}`}>
              {op.dpoEmail}
            </a>
            .
          </p>
        </section>
      )}

      <footer className="flex flex-wrap gap-6 border-t pt-5">
        <Link className="underline underline-offset-2" href="/legal/privacy">
          {t("Política de Privacidade")}
        </Link>
        <Link className="underline underline-offset-2" href="/legal/terms">
          {t("Termos de Uso")}
        </Link>
      </footer>
    </>
  );
}
