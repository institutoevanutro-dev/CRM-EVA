/**
 * A conexão caiu — e você vê isso na tela em que já está.
 *
 * ─── Por que uma faixa, se o aviso já vai para a Central ───────────────────
 *
 * Porque a Central é uma tela que se ABRE, e ninguém a abre por acaso. A falha
 * que originou este componente não foi a falta do aviso — foi a falta de alguém
 * para lê-lo: a sessão caiu, o estado foi gravado, e a descoberta aconteceu
 * horas depois, quando o dono estranhou o silêncio e foi olhar por conta própria.
 * Um aviso guardado onde ninguém passa repete exatamente esse defeito.
 *
 * Esta faixa aparece em TODA tela de /app — inclusive no inbox, onde a pessoa
 * está justamente quando as mensagens deveriam estar chegando. É o lugar onde a
 * ausência delas é sentida.
 *
 * ─── Por que não é e-mail ──────────────────────────────────────────────────
 *
 * Seria melhor: chega mesmo com o navegador fechado. Mas `RESEND_API_KEY` é
 * opcional e está VAZIA numa instalação real — e um aviso que depende de env
 * opcional é um aviso que não existe justamente em quem instalou sozinho e não
 * configurou nada. A faixa funciona em toda instalação, sem configurar nada.
 * O e-mail é um acréscimo possível depois; a faixa é o que não pode faltar.
 */
"use client";
// Client de propósito, e a razão não é interatividade: a faixa é renderizada
// pelo layout de /app, que é servidor, mas fica DENTRO do `IdiomaProvider`. Um
// componente de servidor não enxerga contexto de client, então ou ele recebia o
// idioma por prop — mudando a assinatura e todo chamador — ou passa a ser
// client e o lê de onde já está. Ele não faz nada de servidor: é Link e prosa.
import Link from "next/link";

import { useAuth } from "@/hooks/auth/AuthProvider";
import { useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { useT } from "@/hooks/i18n/useT";
import { ROLE_RANK } from "@/lib/auth/types";
import { conexoesCaidasDe, type ConexaoCaida } from "@/lib/channels/health";
import { WifiSlash } from "@/lib/ui/icons";

/**
 * `caidas` é a PRIMEIRA PINTURA, calculada pelo layout no servidor. Depois a
 * faixa segue a lista de conexões a cada 30 s — a MESMA consulta da bolinha do
 * menu (`ConnectionHealthDot`, mesma chave de cache, uma ida à rede para as
 * duas). Antes ela só era calculada ao carregar a página: o número caía no meio
 * do dia e ninguém via; voltava, e a faixa ficava até o F5, mesmo depois de
 * "WhatsApp conectado!" (auditoria 17/11, item 57). Falha da consulta não apaga
 * a faixa: sem lista nova, vale a última que se tem.
 *
 * `precisaEscanear` muda o texto do botão, não só a cor: reconectar por QR é uma
 * ação concreta ("Escanear"), enquanto um canal em FAILED exige olhar o que
 * aconteceu antes de agir. Mandar "Escanear" para quem precisa investigar faria
 * a pessoa perder tempo numa tela que não resolve o problema dela.
 *
 * Uma linha (auditoria 17/11, item 59): no celular ela quebrava em 3 a 4 linhas
 * e tomava 1/5 da tela. O "nenhuma mensagem entra nem sai" fica na linha a
 * partir de `sm`, e quem não administra lê a orientação em "Detalhes".
 */
export function ConexaoCaidaBanner({ caidas: inicial }: { caidas: ConexaoCaida[] }) {
  const t = useT();
  const { user, activeOrg } = useAuth();
  const { data } = useChannelSessions({ refetchInterval: 30_000 });
  const caidas = data ? conexoesCaidasDe(data) : inicial;
  if (caidas.length === 0) return null;

  const podeAbrirConexoes = (user.is_platform_admin && !user.support)
    || (activeOrg !== null && ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin);
  const uma = caidas.length === 1 ? caidas[0] : null;
  const precisaEscanear = caidas.some((c) => c.status === "SCAN_QR_CODE");

  return (
    // Fundo sólido por baixo do tom de erro (que é translúcido): a faixa gruda
    // por cima do conteúdo que rola.
    <div role="alert" aria-live="assertive" className="border-b border-error/30 bg-background text-error-fg">
      <div className="flex min-h-10 items-center gap-2 bg-error-bg px-4 py-1.5 text-sm">
        <WifiSlash size={16} weight="bold" aria-hidden className="shrink-0" />
        <p className="min-w-0 flex-1 truncate">
          {uma ? (
            <>
              WhatsApp <strong className="font-semibold">{uma.apelido}</strong> {t("desconectado")}
            </>
          ) : (
            <>
              <strong className="font-semibold">
                {caidas.length} {t("conexões")}
              </strong>{" "}
              {t("de WhatsApp desconectadas")}
            </>
          )}
          <span className="hidden sm:inline">{` — ${t("nenhuma mensagem entra nem sai.")}`}</span>
        </p>
        {podeAbrirConexoes ? (
          <Link
            href="/app/connections"
            className="inline-flex min-h-8 shrink-0 items-center rounded-md border border-error/40 bg-background px-3 font-medium text-error-fg hover:bg-error-bg"
          >
            {precisaEscanear ? t("Escanear o QR") : t("Ver conexões")}
          </Link>
        ) : (
          <details className="relative shrink-0">
            <summary className="inline-flex min-h-8 cursor-pointer list-none items-center rounded-md px-2 font-medium underline underline-offset-4 [&::-webkit-details-marker]:hidden">
              {t("Detalhes")}
            </summary>
            <div className="absolute top-full right-0 z-10 mt-2 w-72 max-w-[calc(100vw-2rem)] space-y-1 rounded-md border border-border bg-background p-3 text-sm text-text shadow-lg">
              <p>{t("Nenhuma mensagem entra nem sai.")}</p>
              <p>{t("Peça a quem administra para revisar a conexão do WhatsApp.")}</p>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
