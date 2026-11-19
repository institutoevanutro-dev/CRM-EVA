import { requireAuth } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { Card } from "@/components/ui/card";
import { vapidPronto } from "@/lib/notifications/vapid";
import { NotificationPrefsClient } from "./_client";
import { SonsDosAvisos } from "./_sons";

export const dynamic = "force-dynamic";

/**
 * A TELA PRECISA SABER O QUE ESTA INSTALAÇÃO CONSEGUE FAZER.
 *
 * O backend sempre soube: `GET /api/v1/notifications/push` devolve
 * `enabled: false` sem o par VAPID, e o `PUT` recusa com 503 «Web Push não
 * configurado nesta instalação». Quem não perguntava era esta página.
 *
 * O efeito, num primeiro deploy — que é o estado em que NENHUMA instalação tem
 * as chaves —, era o pior tipo de silêncio:
 *
 *  1. a página afirmava «Push (Chrome) já funcionam» de forma incondicional;
 *  2. a pessoa ligava o interruptor de Push e o navegador pedia permissão —
 *     um incômodo real, cobrado do usuário;
 *  3. ela concedia, e `syncPushSubscription()` fazia `return` em silêncio
 *     (`if (!cfg?.data?.enabled || !publicKey) return`);
 *  4. o interruptor ficava ligado, sem nada avisando que a metade que ela
 *     queria — ser avisada com a aba FECHADA — não ia acontecer.
 *
 * E não havia, em lugar nenhum do produto, como descobrir que faltavam duas
 * variáveis no `.env`. Informação que existe no servidor e não chega a quem
 * decide é o mesmo que informação ausente.
 *
 * ⚠️ O INTERRUPTOR CONTINUA LIGÁVEL DE PROPÓSITO, e isto não é descuido: sem
 * VAPID o aviso na bandeja AINDA funciona enquanto a aba está aberta — é
 * `new Notification()` em `lib/notifications/emit.ts`, que não depende de
 * inscrição nenhuma. Desabilitar o controle tiraria capacidade que a
 * instalação tem. O que faltava era dizer a verdade sobre a metade que ela
 * não tem, e como consegui-la.
 *
 * Server component de propósito: `vapidPronto()` é lido no servidor, então a
 * primeira pintura já sai correta — sem fetch, sem estado intermediário em que
 * a tela promete o que não cumpre.
 */
export default async function NotificationsPage() {
  const user = await requireAuth();
  // `t` local em vez do hook: esta página é componente de SERVIDOR, e lá o
  // idioma vem resolvido em `user.idioma` (a cadeia pessoa → organização →
  // padrão vive em `lib/auth/server.ts`), sem reler o `locale` cru.
  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);
  const pushPronto = vapidPronto();
  const administraAInstalacao = Boolean(user.is_platform_admin && !user.support);

  return (
    <div className="flex h-full flex-col gap-6">
      <header>
        <h1 className="titulo-tela">{t("Notificações")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Escolha como ser avisado. As escolhas valem só neste aparelho e neste navegador.")}
        </p>
      </header>

      {pushPronto ? (
        <Card data-testid="push-status-pronto" className="p-4 text-sm">
          {t("Os avisos chegam aqui mesmo com a aba fechada, depois que você liga a Notificação abaixo.")}
        </Card>
      ) : (
        <Card
          data-testid="push-status-faltando-chaves"
          className="border-warning-border bg-warning-bg p-4 text-sm"
        >
          <p className="font-medium">
            {t("Nesta instalação, os avisos só aparecem com o site aberto.")}
          </p>
          <p className="mt-2 text-muted-foreground">
            {/* ⚠️ Sem o nome do produto aqui, e não por estilo: a instalação é
                white-label e `tests/unit/branding.test.ts` varre `app/` atrás de
                marca escrita à mão. «o site» diz a mesma coisa e serve a quem
                revende o sistema com a marca dele. */}
            {t(
              "Ligar a Notificação abaixo já faz o aviso aparecer na bandeja do sistema enquanto o site está aberto numa aba. Para receber também com a aba fechada, quem administra o servidor precisa configurar uma vez.",
            )}
          </p>
          {/* O passo a passo é de quem administra a instalação (mexe no `.env`):
              para a equipe ele é ruído, e fica recolhido mesmo para quem administra. */}
          {administraAInstalacao ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-muted-foreground">{t("Como configurar no servidor")}</summary>
              <p className="mt-2 text-muted-foreground">{t("Gere um par de chaves uma única vez e reinicie:")}</p>
              <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-2 text-xs">
                <code>npx web-push generate-vapid-keys</code>
              </pre>
              <p className="mt-2 text-muted-foreground">
                {t("O resultado vai no arquivo")} <code>.env</code>, {t("em")}{" "}
                <code>VAPID_PUBLIC_KEY</code> {t("e")} <code>VAPID_PRIVATE_KEY</code>.
              </p>
            </details>
          ) : null}
        </Card>
      )}

      <NotificationPrefsClient />

      <SonsDosAvisos />
    </div>
  );
}
