/**
 * A tela segue avisando que o recebimento não funciona depois do reload.
 *
 * O toast da conexão some; sem o aviso fixo, a tela voltaria a parecer saudável
 * com a Meta entregando as mensagens em outro lugar.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type { OfficialChannelState } from "@/hooks/channels/useOfficialChannel";

let estado: OfficialChannelState;

vi.mock("@/hooks/channels/useOfficialChannel", () => ({
  useOfficialChannel: () => ({ data: { data: estado }, isPending: false }),
  useConnectOfficialChannel: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

import { CanalOficialClient } from "@/components/connections/CanalOficialClient";

function comAssinatura(assinatura: NonNullable<OfficialChannelState["webhook"]>["assinatura"]): OfficialChannelState {
  return {
    channel_session_id: null,
    connected: true,
    hasToken: true,
    phoneNumberId: "1103328999528818",
    wabaId: "2434045433735175",
    displayName: "Clínica",
    phoneNumber: "+5511999998888",
    status: "WORKING",
    webhook: {
      callbackUrl: "https://crm.exemplo.com/api/v1/webhooks/meta/tok",
      verifyToken: null,
      verifyTokenOrigem: "instalacao",
      configurarEm: null,
      fields: ["messages"],
      assinatura,
    },
  };
}

afterEach(cleanup);

describe("CanalOficialClient — aviso de recebimento", () => {
  it("assinatura recusada: aviso fixo com o motivo", () => {
    estado = comAssinatura({ assinado: false, motivo: "Callback verification failed", em: "2026-09-26T12:00:00Z" });
    render(<CanalOficialClient />);
    const aviso = screen.getByTestId("webhook-nao-assinado");
    expect(aviso.textContent).toContain(
      "Conectado, mas a Meta não aceitou o endereço de recebimento. As mensagens não vão chegar.",
    );
    expect(aviso.textContent).toContain("Callback verification failed");
  });

  it("assinatura aceita ou desconhecida: sem aviso", () => {
    estado = comAssinatura({ assinado: true, em: "2026-09-26T12:00:00Z" });
    render(<CanalOficialClient />);
    expect(screen.queryByTestId("webhook-nao-assinado")).toBeNull();
    cleanup();
    estado = comAssinatura(null);
    render(<CanalOficialClient />);
    expect(screen.queryByTestId("webhook-nao-assinado")).toBeNull();
  });
});
