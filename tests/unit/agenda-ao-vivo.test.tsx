/**
 * Achado 2 da auditoria de 16/11: a grade da Agenda não se atualizava sozinha.
 * Consulta marcada pela IA ou por um colega só aparecia depois de recarregar.
 *
 * `useAgendaAoVivo` segue o padrão do funil: canal em `calendar_appointments`
 * da organização (já na publicação `supabase_realtime`) invalidando `["agenda"]`,
 * mais o refetch de segurança a cada 30 s.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const canal = vi.hoisted(() => ({ opts: null as null | Record<string, unknown> }));
const seguranca = vi.hoisted(() => ({ opts: null as null | Record<string, unknown> }));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: (opts: Record<string, unknown>) => {
    canal.opts = opts;
    return { status: "subscribed", ultimaEntrega: { current: null } };
  },
}));
vi.mock("@/hooks/realtime/useRefetchDeSeguranca", () => ({
  useRefetchDeSeguranca: (opts: Record<string, unknown>) => {
    seguranca.opts = opts;
    return { divergencias: 0, ultimaDivergencia: null, ultimaVerificacao: null };
  },
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ orgId: "org-1", name: "Clínica Fictícia", role: "agent" }),
}));

import { useAgendaAoVivo } from "@/hooks/agenda/useAgendaAoVivo";

const RECORTE = { de: "2030-01-13T03:00:00.000Z", ate: "2030-01-20T03:00:00.000Z" };

describe("a agenda escuta o banco", () => {
  it("assina calendar_appointments DA organização e invalida tudo de agenda a cada mudança", async () => {
    const qc = new QueryClient();
    const invalidar = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useAgendaAoVivo(RECORTE), {
      wrapper: ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children),
    });

    expect(canal.opts).toMatchObject({
      enabled: true,
      postgresChanges: { table: "calendar_appointments", filter: "organization_id=eq.org-1" },
    });
    (canal.opts!.onChange as (p: unknown) => void)({ eventType: "INSERT" });
    expect(invalidar).toHaveBeenCalledWith({ queryKey: ["agenda"] });
  });

  it("e confere de 30 em 30 s a mesma chave que a grade lê (cobre DELETE, Google e canal morto)", () => {
    const qc = new QueryClient();
    renderHook(() => useAgendaAoVivo(RECORTE), {
      wrapper: ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children),
    });
    expect(seguranca.opts).toMatchObject({
      queryKey: ["agenda", "agendamentos", RECORTE],
      intervaloMs: 30_000,
      enabled: true,
    });
    const assinatura = seguranca.opts!.assinatura as (l: unknown) => string;
    const um = [{ id: "a", revision: 1, comeca: "x", situacao: "confirmed" }];
    const remarcado = [{ id: "a", revision: 2, comeca: "y", situacao: "confirmed" }];
    expect(assinatura(um)).not.toBe(assinatura(remarcado));
  });
});
