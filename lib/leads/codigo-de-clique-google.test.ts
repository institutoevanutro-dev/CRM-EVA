import { describe, expect, it, vi } from "vitest";

import { aplicarCodigoDeCliqueGoogle, codigoNaMensagem } from "./codigo-de-clique-google";

vi.mock("@/lib/leads/atribuicao-de-anuncio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/leads/atribuicao-de-anuncio")>()),
  estamparAtribuicaoDoContato: vi.fn(),
}));
import { estamparAtribuicaoDoContato } from "@/lib/leads/atribuicao-de-anuncio";

describe("código de clique na mensagem", () => {
  it("acha o código no fim da mensagem pré-preenchida, com ou sem acento e ponto", () => {
    expect(codigoNaMensagem("Olá, quero agendar\nCód. 952FHZ")).toBe("952FHZ");
    expect(codigoNaMensagem("cod 952fhz")).toBe("952FHZ");
    expect(codigoNaMensagem("Cód.952FHZ obrigado")).toBe("952FHZ");
  });

  it("ignora o que não é código do site", () => {
    expect(codigoNaMensagem("quero agendar")).toBeNull();
    expect(codigoNaMensagem("Cód. 952F0Z")).toBeNull(); // 0 não existe no alfabeto
    expect(codigoNaMensagem("Cód. 952FHZX")).toBeNull(); // 7 caracteres
    expect(codigoNaMensagem(null)).toBeNull();
  });
});

function adminCom(linha: unknown) {
  const filtros: [string, unknown][] = [];
  const q = {
    update: () => q,
    eq: (c: string, v: unknown) => (filtros.push([c, v]), q),
    is: (c: string, v: unknown) => (filtros.push([c, v]), q),
    gte: () => q,
    select: () => q,
    maybeSingle: async () => ({ data: linha, error: null }),
  };
  return { admin: { from: () => q } as never, filtros };
}

describe("aplicarCodigoDeCliqueGoogle", () => {
  it("consome o código da organização e estampa o contato como Google com o gclid", async () => {
    const { admin, filtros } = adminCom({ click_id_kind: "gclid", click_id: "Cj0KCQabc123", landing_url: "https://x", clicked_at: null });
    expect(await aplicarCodigoDeCliqueGoogle(admin, "org-1", "ct-1", "oi\nCód. 952FHZ")).toBe(true);
    expect(filtros).toContainEqual(["organization_id", "org-1"]);
    expect(filtros).toContainEqual(["used_at", null]);
    expect(estamparAtribuicaoDoContato).toHaveBeenCalledWith(admin, "ct-1", expect.objectContaining({
      plataforma: "google_ads",
      bruto: expect.objectContaining({ gclid: "Cj0KCQabc123", codigo: "952FHZ" }),
    }));
  });

  it("código já usado, vencido ou de outra organização: não estampa", async () => {
    vi.mocked(estamparAtribuicaoDoContato).mockClear();
    const { admin } = adminCom(null);
    expect(await aplicarCodigoDeCliqueGoogle(admin, "org-1", "ct-1", "Cód. 952FHZ")).toBe(false);
    expect(estamparAtribuicaoDoContato).not.toHaveBeenCalled();
  });
});

describe("aplicarCodigoDeCliqueGoogle — campanha da página de destino (porte do projeto original, PR #4631)", () => {
  it("lê campanha, grupo, anúncio, palavra-chave e conta da query da landing_url", async () => {
    vi.mocked(estamparAtribuicaoDoContato).mockClear();
    const landing =
      "https://site.test/agendar?utm_campaign=Consultas&utm_adset=Zona%20sul&utm_term=consulta%20perto" +
      "&campaignid=123&adgroupid=456&creative=789&google_customer_id=123-456-7890&gclid=Cj0KCQabc123&outra=x";
    const { admin } = adminCom({ click_id_kind: "gclid", click_id: "Cj0KCQabc123", landing_url: landing, clicked_at: null });
    await aplicarCodigoDeCliqueGoogle(admin, "org-1", "ct-1", "Cód. 952FHZ");
    expect(estamparAtribuicaoDoContato).toHaveBeenCalledWith(admin, "ct-1", expect.objectContaining({
      metadadosDaCampanha: {
        utm_campaign: "Consultas",
        utm_adset: "Zona sul",
        utm_term: "consulta perto",
        google_campaign_id: "123",
        google_adgroup_id: "456",
        google_ad_id: "789",
        google_customer_id: "1234567890",
      },
    }));
  });

  it("sem landing_url (ou inválida) a campanha vem vazia e o clique entra assim mesmo", async () => {
    vi.mocked(estamparAtribuicaoDoContato).mockClear();
    const { admin } = adminCom({ click_id_kind: "gclid", click_id: "Cj0KCQabc123", landing_url: "não é url", clicked_at: null });
    expect(await aplicarCodigoDeCliqueGoogle(admin, "org-1", "ct-1", "Cód. 952FHZ")).toBe(true);
    expect(estamparAtribuicaoDoContato).toHaveBeenCalledWith(admin, "ct-1", expect.objectContaining({ metadadosDaCampanha: {} }));
  });
});
