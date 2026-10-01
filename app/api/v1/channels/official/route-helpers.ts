/**
 * Compartilhado pelas rotas do canal oficial (formulário manual e Cadastro
 * Incorporado). Next ignora este arquivo como rota: só `route.ts` vira endpoint.
 */
import type { NextRequest } from "next/server";

import { env } from "@/lib/env";

/**
 * Base pública desta instalação — é o que o operador cola no dashboard da Meta.
 *
 * `env.*` e NÃO `process.env.NEXT_PUBLIC_APP_URL` direto: variáveis
 * `NEXT_PUBLIC_` são substituídas no BUILD, e a imagem genérica do self-host é
 * construída com `https://placeholder.invalid` (Dockerfile). Lendo direto do
 * `process.env`, a tela mostrava essa URL — e quem a colasse no dashboard
 * apontaria o webhook para o nada, sem erro em lugar nenhum.
 */
export function publicBase(req: NextRequest): string {
  const configurada = env.NEXT_PUBLIC_APP_URL;
  const usavel = configurada && !configurada.includes("placeholder.invalid") ? configurada : null;
  return (
    usavel ?? req.headers.get("origin") ?? `${req.nextUrl.protocol}//${req.nextUrl.host}`
  );
}

const PREFIXO_REDE = "rede indisponível:";

/** Motivo fixo vai ao dicionário; o de rede traduz só o prefixo (o resto é do sistema). */
export function traduzirMotivo(motivo: string, t: (texto: string) => string): string {
  return motivo.startsWith(PREFIXO_REDE) ? `${t(PREFIXO_REDE)}${motivo.slice(PREFIXO_REDE.length)}` : t(motivo);
}
