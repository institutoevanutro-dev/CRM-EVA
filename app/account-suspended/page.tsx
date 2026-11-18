import Link from "next/link";
import { signOut } from "@/app/actions/auth/signOut";
import { OutrasOrganizacoes } from "@/components/auth/OutrasOrganizacoes";
import { loadAuthUser } from "@/lib/auth/server";
import { emailDeSuporte } from "@/lib/branding/saida";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";

export const metadata = {
  title: "Conta suspensa",
};

/**
 * Esta tela entregava o NOSSO endereço de suporte ao cliente de um revendedor —
 * e aqui isso é ativamente errado: quem suspendeu a conta foi o revendedor, e
 * escrever para nós não desbloqueia nada. O endereço agora sai de
 * `SUPPORT_EMAIL` (o do operador) e, quando ninguém configurou, o parágrafo do
 * contato simplesmente NÃO renderiza. Cair de volta num endereço do produto
 * seria o defeito de volta, com o agravante de parecer resolvido.
 */
export default async function AccountSuspendedPage() {
  const suporte = emailDeSuporte();
  // Rota fora da árvore de `app/app/layout.tsx` — sem `IdiomaProvider`, então
  // resolve o idioma direto, como `admin/forbidden/page.tsx`. Quem chega aqui
  // normalmente tem sessão do Supabase Auth (a suspensão é regra do produto,
  // não um ban de autenticação), mas `user` fica opcional por segurança.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const idioma = normalizarIdioma(
    (user?.user_metadata?.locale as string | undefined) ?? null,
  );
  // Quem é de outras organizações não fica preso na suspensa (auditoria 17/11,
  // item 54): só as ATIVAS, lidas agora — a ação de trocar confere de novo.
  const outras = await organizacoesAtivasAlemDaSuspensa(supabase);

  return (
    <IdiomaProvider locale={idioma}>
    <main className="flex min-h-screen items-center justify-center p-8">
      <Card className="w-full max-w-md p-8 text-center space-y-4">
        <h1 className="titulo-tela">{traduzir("Conta suspensa", idioma)}</h1>
        {suporte ? (
          <p className="text-sm text-muted-foreground">
            {traduzir("Sua conta está suspensa. Entre em contato com", idioma)}{" "}
            <a
              href={`mailto:${suporte}`}
              className="underline underline-offset-4 hover:text-foreground transition-colors"
            >
              {suporte}
            </a>{" "}
            {traduzir("para mais informações.", idioma)}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {traduzir(
              "Sua conta está suspensa. Fale com quem administra este sistema para saber o motivo e como reativá-la.",
              idioma,
            )}
          </p>
        )}
        <OutrasOrganizacoes organizacoes={outras} />
        <div className="pt-2">
          {user ? (
            // "Sair" de verdade: o link para /login deixava a sessão aberta e a
            // pessoa voltava para cá ao entrar.
            <form action={signOut}>
              <Button type="submit" variant="outline">
                {traduzir("Sair", idioma)}
              </Button>
            </form>
          ) : (
            <Button asChild variant="outline">
              <Link href="/login">{traduzir("Entrar", idioma)}</Link>
            </Button>
          )}
        </div>
      </Card>
    </main>
    </IdiomaProvider>
  );
}

async function organizacoesAtivasAlemDaSuspensa(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ id: string; nome: string }[]> {
  const authUser = await loadAuthUser().catch(() => null);
  if (!authUser || authUser.organizations.length < 2) return [];
  const ids = authUser.organizations.map((o) => o.organization_id);
  const { data, error } = await supabase.from("organizations").select("id, status").in("id", ids);
  if (error || !data) return [];
  const ativas = new Set(data.filter((o) => o.status === "active").map((o) => o.id as string));
  return authUser.organizations
    .filter((o) => ativas.has(o.organization_id))
    .map((o) => ({ id: o.organization_id, nome: o.organization_name }));
}
