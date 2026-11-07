/**
 * O PUSH DE MENSAGEM NOVA É ESCOLHA DE QUEM SE INSCREVEU (migration 0404).
 *
 * O botão "Nova mensagem › Push" só existia no `localStorage`: o servidor
 * mandava toda mensagem recebida a toda inscrição. E, com o botão desligado
 * ANTES de se inscrever, `syncPushSubscription()` nem inscrevia — e o aviso da
 * IA chamando a equipe também não chegava.
 *
 *  1. O PUT grava `recebe_mensagens` (ausente = `true`, navegador antigo).
 *  2. O cliente inscreve com a permissão concedida mesmo com o botão
 *     desligado, e manda o botão junto.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/notifications/vapid", () => ({ vapidPronto: () => true, vapidPublica: () => "AQAB" }));
vi.mock("@/lib/notifications/service_worker", () => ({ ensureNotifyServiceWorker: vi.fn() }));

const { PUT } = await import("@/app/api/v1/notifications/push/route");
const { syncPushSubscription } = await import("@/lib/notifications/push_client");
const { ensureNotifyServiceWorker } = await import("@/lib/notifications/service_worker");

const ORG = "aaaaaaaa-0000-4000-8000-000000000404";
const USUARIO = "dddddddd-0000-4000-8000-000000000404";
const ENDPOINT = "https://push.exemplo.test/inscricao-ficticia";

describe("PUT /api/v1/notifications/push", () => {
  let gravadas: Array<Record<string, unknown>>;

  beforeEach(() => {
    gravadas = [];
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      org: { orgId: ORG },
      user: { id: USUARIO, idioma: "pt" },
    } as never);
    vi.mocked(createClient).mockResolvedValue({
      from: () => ({
        upsert: async (linha: Record<string, unknown>) => {
          gravadas.push(linha);
          return { error: null };
        },
      }),
    } as never);
  });

  function put(corpo: Record<string, unknown>): Promise<Response> {
    return PUT(
      new NextRequest("http://local/api/v1/notifications/push", {
        method: "PUT",
        body: JSON.stringify({ endpoint: ENDPOINT, keys: { p256dh: "k", auth: "a" }, ...corpo }),
      }),
    );
  }

  it("grava recebe_mensagens=false quando o botão está desligado", async () => {
    const res = await put({ recebe_mensagens: false });
    expect(res.status).toBe(200);
    expect(gravadas[0]).toMatchObject({ organization_id: ORG, user_id: USUARIO, recebe_mensagens: false });
  });

  it("sem o campo (navegador antigo): grava true", async () => {
    await put({});
    expect(gravadas[0]).toMatchObject({ recebe_mensagens: true });
  });

  it("campo que não é booleano: 422 e nada gravado", async () => {
    const res = await put({ recebe_mensagens: "nao" });
    expect(res.status).toBe(422);
    expect(gravadas).toEqual([]);
  });
});

describe("syncPushSubscription", () => {
  let puts: Array<Record<string, unknown>>;
  const subscribe = vi.fn();

  beforeEach(() => {
    puts = [];
    subscribe.mockReset();
    subscribe.mockResolvedValue({
      toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: "k", auth: "a" } }),
    });
    vi.mocked(ensureNotifyServiceWorker).mockResolvedValue({
      pushManager: { getSubscription: async () => null, subscribe },
    } as never);
    vi.stubGlobal("Notification", { permission: "granted" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
        if (init?.method === "PUT") {
          puts.push(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
          return new Response("{}");
        }
        return new Response(JSON.stringify({ data: { enabled: true, public_key: "AQAB" } }));
      }),
    );
    window.localStorage.clear();
  });

  it("com 'Nova mensagem › Push' desligado: inscreve mesmo assim e manda recebe_mensagens=false", async () => {
    window.localStorage.setItem("alerts.enabled", "0");
    await syncPushSubscription();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ endpoint: ENDPOINT, recebe_mensagens: false });
  });

  it("com o botão ligado: recebe_mensagens=true", async () => {
    window.localStorage.setItem("alerts.enabled", "1");
    await syncPushSubscription();
    expect(puts[0]).toMatchObject({ recebe_mensagens: true });
  });

  it("sem a permissão do navegador: não inscreve", async () => {
    vi.stubGlobal("Notification", { permission: "default" });
    await syncPushSubscription();
    expect(subscribe).not.toHaveBeenCalled();
    expect(puts).toEqual([]);
  });
});
