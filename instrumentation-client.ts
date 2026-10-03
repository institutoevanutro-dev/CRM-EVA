// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { resolveSentryDsn } from "./lib/sentry/dsn";
import { integracoesDeReplay, pararReplayEmRotaComCredencial } from "./lib/sentry/replay";
import { sentryScrubHooks } from "./lib/sentry/scrub";

const sentryDsn = resolveSentryDsn(
  typeof window !== "undefined" ? window.__PUBLIC_ENV__?.SENTRY_DSN : undefined,
);

Sentry.init({
  dsn: sentryDsn,

  // O replayIntegration() mantém os defaults maskAllText/blockAllMedia. Vai com o
  // scrub de URL do projeto, e sem gravar a página que tem credencial na URL
  // (ver lib/sentry/replay.ts).
  integrations: integracoesDeReplay(
    typeof window !== "undefined" ? window.location.href : "",
    Sentry.replayIntegration,
  ),

  tracesSampleRate: 1,
  enableLogs: true,

  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,

  sendDefaultPii: false,

  ...sentryScrubHooks,
});

export function onRouterTransitionStart(href: string, navigationType: string): void {
  pararReplayEmRotaComCredencial(href, Sentry.getReplay());
  Sentry.captureRouterTransitionStart(href, navigationType);
}
