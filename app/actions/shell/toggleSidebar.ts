"use server";
import { cookies } from "next/headers";
import { cookieSecure } from "@/lib/supabase/cookie-secure";

/**
 * Grava a preferência para a PRIMEIRA PINTURA da próxima carga. Não chama
 * `revalidatePath` (D1.10): quem muda o menu na hora é o estado do `AppShell`;
 * redesenhar o layout inteiro no servidor fazia o « esperar mais de 1 s.
 */
export async function toggleSidebar(currentlyCollapsed: boolean): Promise<void> {
  const store = await cookies();
  store.set("sidebar_collapsed", currentlyCollapsed ? "0" : "1", {
    httpOnly: true,
    sameSite: "strict",
    secure: cookieSecure(),
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}
