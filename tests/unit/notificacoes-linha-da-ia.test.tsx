/**
 * A LINHA "CONVERSA PASSADA PELA IA" PEDE A PERMISSÃO SEM LIGAR "NOVA MENSAGEM".
 *
 * A única forma de o navegador pedir permissão era ligar o Push de "Nova
 * mensagem" — justamente o que a equipe não quer (centenas de avisos por dia).
 * O passo a passo agora é: ligar esta linha, tocar em Permitir, e "Nova
 * mensagem" fica como estava. E o iPhone fora da Tela de Início, que não tem
 * push nenhum, ouve como resolver em vez de ver um interruptor travado e mudo.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sync = vi.fn(async () => undefined);
vi.mock("@/lib/notifications/push_client", () => ({ syncPushSubscription: () => sync() }));
vi.mock("@/lib/notifications/service_worker", () => ({ ensureNotifyServiceWorker: vi.fn(async () => null) }));
vi.mock("@/lib/notifications/sounds", () => ({ resumeAudio: vi.fn(async () => undefined) }));
vi.mock("@/lib/notifications/emit", () => ({ emitNotification: vi.fn() }));

const original = Reflect.getOwnPropertyDescriptor(globalThis, "Notification");

function comNotification(valor: { permission: string; requestPermission: () => Promise<string> } | null): void {
  if (valor === null) Reflect.deleteProperty(globalThis, "Notification");
  else Object.defineProperty(globalThis, "Notification", { configurable: true, writable: true, value: valor });
}

async function tela() {
  vi.resetModules();
  const { NotificationPrefsClient } = await import("@/app/app/settings/notifications/_client");
  return render(<NotificationPrefsClient />);
}

beforeEach(() => {
  sync.mockClear();
  window.localStorage.clear();
});

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "Notification", original);
  else Reflect.deleteProperty(globalThis, "Notification");
});

describe("Configurações › Notificações — Conversa passada pela IA", () => {
  it("ligar a linha pede a permissão, inscreve o aparelho e NÃO liga 'Nova mensagem'", async () => {
    // Quem já tinha desligado "Nova mensagem" neste navegador.
    window.localStorage.setItem("alerts.enabled", "0");
    const notif = {
      permission: "default",
      requestPermission: vi.fn(async () => {
        notif.permission = "granted";
        return "granted";
      }),
    };
    comNotification(notif);
    await tela();

    const linha = screen.getByRole("switch", { name: "Conversa passada pela IA via push" });
    // Ligada por padrão, mas sem permissão ainda aparece desligada: é ligando
    // que a pessoa chega ao "Permitir".
    expect(linha.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(linha);
    await waitFor(() => expect(sync).toHaveBeenCalled());
    expect(notif.requestPermission).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem("alerts.enabled")).toBe("0");
    expect(screen.getByRole("switch", { name: "Nova mensagem via push" }).getAttribute("aria-checked")).toBe("false");
  });

  it("navegador sem notificação (iPhone fora da Tela de Início): explica como resolver", async () => {
    comNotification(null);
    await tela();
    expect(screen.getByTestId("push-sem-suporte").textContent).toMatch(/Tela de Início.*iOS 16\.4/);
  });
});
