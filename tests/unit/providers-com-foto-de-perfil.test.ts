import { describe, expect, it } from "vitest";

import { providersComFotoDePerfil } from "@/lib/channels";
import { CHANNEL_PROVIDER_INSTAGRAM, CHANNEL_PROVIDER_WAHA } from "@/lib/channels/capabilities";

describe("providersComFotoDePerfil pergunta ao adapter", () => {
  it("inclui quem busca foto de contato de telefone e deixa a conta do Instagram de fora", () => {
    expect(providersComFotoDePerfil()).toContain(CHANNEL_PROVIDER_WAHA);
    expect(providersComFotoDePerfil()).not.toContain(CHANNEL_PROVIDER_INSTAGRAM);
  });
});
