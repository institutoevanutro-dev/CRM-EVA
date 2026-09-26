import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { CanaisDoContato } from "@/components/contacts/CanaisDoContato";

vi.mock("next/link", () => ({
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * A FICHA MOSTRA POR QUAIS CANAIS A PESSOA FALA.
 *
 * Um contato pode ter conversa no WhatsApp e no Instagram ao mesmo tempo (dois
 * números da clínica, dois canais). Sem esta lista, quem abre a ficha só
 * enxerga o telefone do cabeçalho e não sabe que existe uma conversa no
 * Instagram — nem qual @ a pessoa usa lá, nem qual perfil da clínica recebeu.
 */
function stubConversas(data: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ data })),
  );
}

const conversaWhatsapp = {
  id: "conv-wpp-1",
  channel: "whatsapp",
  is_group: false,
  provider_conversation_id: null,
  contacts: {
    phone_number: "+5532984793302",
    contact_channel_identities: [],
  },
  channel_sessions: {
    phone_number: "+5532999990000",
    display_name: null,
    provider: "waha",
  },
};

const conversaInstagram = {
  id: "conv-ig-1",
  channel: "instagram",
  is_group: false,
  provider_conversation_id: "igsid-maria",
  contacts: {
    phone_number: null,
    contact_channel_identities: [
      { channel: "instagram", external_id: "igsid-maria", handle: "maria.silva", display_name: "Maria Silva" },
    ],
  },
  channel_sessions: {
    phone_number: null,
    display_name: "@instit.eva",
    provider: "meta_instagram",
  },
};

describe("CanaisDoContato", () => {
  it("mostra uma linha por conversa 1:1, com selo, identificador e a sessão de origem", async () => {
    stubConversas([conversaWhatsapp, conversaInstagram]);
    render(<CanaisDoContato contactId="contato-1" />);

    await waitFor(() => expect(screen.getByLabelText("Instagram")).toBeInTheDocument());
    expect(screen.getByText("@maria.silva")).toBeInTheDocument();
    expect(screen.getByText(/via @instit\.eva/)).toBeInTheDocument();
    expect(screen.getByText("@maria.silva").closest("a")).toHaveAttribute(
      "href",
      "/app/inbox?id=conv-ig-1",
    );

    expect(screen.getByLabelText("WhatsApp")).toBeInTheDocument();
    expect(screen.getByText("+5532984793302")).toBeInTheDocument();
    expect(screen.getByText("+5532984793302").closest("a")).toHaveAttribute(
      "href",
      "/app/inbox?id=conv-wpp-1",
    );
  });

  it("sem conversas, a seção some por completo", async () => {
    stubConversas([]);
    const { container } = render(<CanaisDoContato contactId="contato-1" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("conversa de grupo não entra na lista", async () => {
    stubConversas([{ ...conversaWhatsapp, id: "conv-grupo", is_group: true }]);
    const { container } = render(<CanaisDoContato contactId="contato-1" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
