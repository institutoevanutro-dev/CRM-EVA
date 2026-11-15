import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NiveisDaOrigemGoogle } from "@/components/contacts/NiveisDaOrigemGoogle";
import { origemGoogleAds } from "@/lib/leads/origem-google-ads";
import { metadadosGoogleDaUrl, normalizarMetadadosGoogle } from "@/lib/plataformas-de-anuncio/google/metadados-da-campanha";

/**
 * A origem do Google Ads na ficha do contato e do negócio — porte do DeskcommCRM
 * (PR #4631 de @SerusoNakamoto), adaptado ao recorte do fork.
 */
const META = {
  ad_platform: "google_ads",
  utm_campaign: "Consultas",
  utm_adset: "Zona sul",
  utm_ad: "Avaliação",
  utm_term: "consulta perto",
  google_campaign_id: "123",
  google_adgroup_id: "456",
  google_ad_id: "789",
  google_customer_id: "9876543210",
};

describe("origemGoogleAds", () => {
  it("nome com ID quando os dois existem, e só a plataforma provada conta", () => {
    expect(origemGoogleAds(META, "whatsapp")).toEqual({
      campanha: "Consultas (123)",
      grupo: "Zona sul (456)",
      anuncio: "Avaliação (789)",
      palavraChave: "consulta perto",
      conta: "9876543210",
    });
    expect(origemGoogleAds({ utm_source: "google", utm_campaign: "Consultas" }, "website")).toBeNull();
    expect(origemGoogleAds({ ...META, ad_platform: "meta_ads" }, "meta_ads")).toBeNull();
    expect(origemGoogleAds({ google_campaign_id: "123" }, "google_ads")?.campanha).toBe("123");
  });

  it("valor legado malformado não aparece", () => {
    const o = origemGoogleAds({ ad_platform: "google_ads", utm_campaign: "https://x.test", google_customer_id: "123" }, null);
    expect(o).toEqual({ campanha: null, grupo: null, anuncio: null, palavraChave: null, conta: null });
  });
});

describe("normalização da campanha", () => {
  it("aceita só IDs numéricos e conta com 10 dígitos; clique nunca vira conta", () => {
    expect(normalizarMetadadosGoogle({ campaignid: "1e3", gclid: "1234567890", customer_id: "123-456-7890" })).toEqual({
      google_customer_id: "1234567890",
    });
    expect(metadadosGoogleDaUrl("https://site.test/?utm_campaign=%7Bcampaignid%7D")).toEqual({});
    expect(metadadosGoogleDaUrl(null)).toEqual({});
  });
});

describe("NiveisDaOrigemGoogle", () => {
  it("mostra cada nível com valor e esconde o que falta", () => {
    render(
      <dl>
        <NiveisDaOrigemGoogle origem={{ campanha: "Consultas (123)", grupo: null, anuncio: null, palavraChave: "consulta perto", conta: null }} />
      </dl>,
    );
    expect(screen.getByText("Campanha")).toBeInTheDocument();
    expect(screen.getByText("Consultas (123)")).toBeInTheDocument();
    expect(screen.getByText("consulta perto")).toBeInTheDocument();
    expect(screen.queryByText("Grupo de anúncios")).toBeNull();
    expect(screen.queryByText("Conta do Google Ads")).toBeNull();
  });
});
