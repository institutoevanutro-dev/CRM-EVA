"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { cookieSecure } from "@/lib/supabase/cookie-secure";

/**
 * A preferência do painel do contato recolhido: o MESMO caminho do recolher do
 * menu da esquerda (`app/actions/shell/toggleSidebar.ts`). Cookie httpOnly
 * gravado por server action e lido no servidor (`app/app/inbox/page.tsx`).
 *
 * Cookie, e não `localStorage`, de propósito: sem a leitura no servidor o
 * primeiro render traz o painel aberto e ele só recolhe depois da hidratação
 * (a conversa nasce estreita e pula para larga), o flash que o
 * `sidebar_collapsed` já evita no `app/app/layout.tsx`.
 *
 * Recebe o estado ATUAL, como `toggleSidebar`.
 */
export async function togglePainelDoContato(currentlyCollapsed: boolean): Promise<void> {
  const store = await cookies();
  store.set("inbox_painel_recolhido", currentlyCollapsed ? "0" : "1", {
    httpOnly: true,
    sameSite: "strict",
    secure: cookieSecure(),
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  revalidatePath("/app/inbox");
}
