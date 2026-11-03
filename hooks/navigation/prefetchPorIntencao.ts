"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef } from "react";

/**
 * PREFETCH POR INTENÇÃO: o menu pede a tela só quando alguém vai para ela
 * (porte do original #3613, issue #3170 lá).
 *
 * ─── O defeito ───────────────────────────────────────────────────────────────
 *
 * O `<Link>` do App Router prefetcha sozinho TODO destino que entra na viewport,
 * e cada prefetch é um render RSC COMPLETO: o `proxy.ts` confere a sessão
 * (`getUser`) e `app/app/layout.tsx` roda `loadAuthUser`, `resolveActiveOrg` e as
 * consultas da organização, das conexões e do MFA até chegar a
 * `app/app/loading.tsx`, contra o Supabase na nuvem, para entregar só a casca.
 *
 * Nesta base, contado no código e não medido: em `/app/inbox` o menu da lateral
 * desenha 15 links (Início, os 6 grupos, as 7 telas do Atendimento e
 * Configurações), 13 destinos distintos além da tela atual; a gaveta do celular
 * só monta quando abre. A rajada vem ao carregar o documento, depois de um
 * `router.refresh()` ou de uma invalidação do cache e quando o cache do router
 * vence; NÃO a cada troca de tela, porque o cache não repete o que já tem.
 *
 * Medido no original (build de produção): 37 pedidos `?_rsc=` por tela (19
 * destinos × as duas instâncias do menu de lá) e, sem a rajada, o clique caiu de
 * p50 765 para 470 ms; o TTFB do destino, de 339 para 152 ms com 30 ms de RTT
 * até o banco. A espera é no servidor: esses renders disputam CPU e banco com o
 * render que a pessoa pediu.
 *
 * O mesmo bando já atropelou `router.refresh()` aqui (ver
 * `components/branding/CampoDeLogo.tsx`, `lib/branding/instalacao.ts` e
 * `app/app/kanban/_client.tsx`).
 *
 * ─── O que este hook faz ─────────────────────────────────────────────────────
 *
 * Desliga o prefetch automático (`prefetch: false`) e o move para a INTENÇÃO:
 * `pointerenter` e `focus`, os sinais que antecedem o clique de quem usa mouse e
 * de quem usa teclado. O `pointerenter` também dispara no começo de um toque, e
 * por isso substitui o `onTouchStart` do `<Link>`. Quem só passa o olho pela tela
 * não gera render nenhum.
 *
 * Espalhar o retorno num `<Link>` aplica as duas metades juntas, de propósito:
 * não existe o estado "lembrei do handler e esqueci do `prefetch={false}`", que é
 * o que traz o bando de volta.
 *
 * O `Set` é por montagem e pede cada destino uma vez. Enquanto a entrada está
 * fresca o cache do router já não repete o pedido, então o `Set` só põe um teto
 * (mantido igual ao original).
 * ponytail: a lateral do computador fica montada a sessão inteira; depois que o
 * cache do router vence (~5 min) ou de um `router.refresh()`, passar o ponteiro
 * não pede mais nada até recarregar, e o clique traz o dado novo sem o esqueleto
 * pronto. E `router.prefetch` entra na fila com prioridade Default, não Intent
 * como o hover do próprio `<Link>`. Saída: tirar o `Set` (e o 4º caso do teste),
 * já que o cache de segmentos do Next 16.4.2 pula o que está pronto ou em voo,
 * só depois de medir no navegador.
 */
export function usePrefetchPorIntencao() {
  const router = useRouter();
  const jaPedidos = useRef(new Set<string>());

  return useCallback(
    (href: string) => {
      const pedir = () => {
        if (jaPedidos.current.has(href)) return;
        jaPedidos.current.add(href);
        router.prefetch(href);
      };
      return { prefetch: false as const, onPointerEnter: pedir, onFocus: pedir };
    },
    [router],
  );
}
