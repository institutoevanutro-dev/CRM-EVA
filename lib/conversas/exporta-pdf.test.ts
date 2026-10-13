// @vitest-environment node
//
// O modelo de conteúdo do PDF da conversa, e o arquivo de verdade: os casos de
// render leem o texto de DENTRO do PDF gerado (em jsdom o pdfjs-dist quebra).
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { extractPdfText } from "@/lib/ai/rag/extractors/pdf";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// A marca vem da pilha instalação/organização em produção; aqui é fixa.
vi.mock("@/lib/branding/saida", async (original) => ({
  ...(await original<typeof import("@/lib/branding/saida")>()),
  marcaDaSaida: vi.fn(async () => ({
    nome: "Marca da Instalação",
    logoUrl: null,
    accent: "#0f766e",
    accentFg: "#ffffff",
    origens: { nome: "padrao", cor: "padrao" },
  })),
}));

import {
  LIMITE_DE_CARACTERES_POR_MENSAGEM,
  linhasDoHistorico,
  montarPdfDaConversa,
  type ConversaParaPdf,
  type MensagemParaPdf,
} from "./exporta-pdf";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const ANA = "11111111-1111-4111-8111-111111111111";
const t = (texto: string) => texto;

const conversa: ConversaParaPdf = {
  id: "33333333-3333-4333-8333-333333333333",
  channel: "whatsapp",
  contato: { name: "José da Silva", display_name: null, phone_number: "+5527999990000" },
};

function msg(parcial: Partial<MensagemParaPdf> & { id: string; sent_at: string }): MensagemParaPdf {
  return {
    direction: "inbound",
    type: "text",
    status: "received",
    body: null,
    sent_via: "external_device",
    sent_by_user_id: null,
    created_at: parcial.sent_at,
    metadata: {},
    ...parcial,
  };
}

const nomesDosUsuarios = new Map<string, string | null>([[ANA, "Ana Souza"]]);

/** O client só é usado para ler a organização. */
function db(org: Record<string, unknown> | null): SupabaseClient {
  const cadeia = { select: () => cadeia, eq: () => cadeia, maybeSingle: async () => ({ data: org, error: null }) };
  return { from: () => cadeia } as unknown as SupabaseClient;
}

const ORG = { legal_name: "Clínica Bem Viver LTDA", display_name: "Clínica Bem Viver", timezone: "America/Sao_Paulo" };

describe("linhasDoHistorico: quem falou", () => {
  const linhaDe = (m: Omit<Partial<MensagemParaPdf>, "id" | "sent_at">) =>
    linhasDoHistorico(conversa, [msg({ id: "m", sent_at: "2026-09-01T12:00:00.000Z", ...m })], { t, nomesDosUsuarios })[0]!;

  it("mensagem recebida é do contato, pelo nome", () => {
    expect(linhaDe({ body: "oi" })).toMatchObject({ papel: "contato", autor: "José da Silva" });
  });

  it("enviada pelo CRM leva o NOME de quem enviou", () => {
    expect(linhaDe({ direction: "outbound", sent_via: "user", sent_by_user_id: ANA, body: "olá" })).toMatchObject({
      papel: "equipe",
      autor: "Ana Souza (equipe)",
    });
  });

  it("sem nome resolvido, não inventa identidade: Equipe", () => {
    expect(linhaDe({ direction: "outbound", sent_via: "crm", sent_by_user_id: "outro", body: "olá" })).toMatchObject({
      papel: "equipe",
      autor: "Equipe",
    });
  });

  it("digitada no celular é a EQUIPE, nunca a IA", () => {
    const linha = linhaDe({ direction: "outbound", sent_via: "external_device", body: "já te respondo" });
    expect(linha).toMatchObject({ papel: "equipe", autor: "Equipe (pelo celular)" });
  });

  it("texto escrito por modelo é o assistente virtual", () => {
    for (const metadata of [{ ai_actor_id: "a1" }, { ai_generated: true }, { texto_escrito_pela_ia: true }]) {
      expect(linhaDe({ direction: "outbound", sent_via: "ai", body: "posso ajudar", metadata })).toMatchObject({
        papel: "ia",
        autor: "Assistente virtual (IA)",
      });
    }
  });

  it("sent_via='ai' sem marca de modelo (lembrete, campanha, resposta pronta) é mensagem automática, não IA", () => {
    for (const metadata of [{}, { resposta_pronta_id: "r1" }, { ai_actor_id: "a1", aviso_de_escalacao: true }]) {
      expect(linhaDe({ direction: "outbound", sent_via: "ai", body: "sua consulta é amanhã", metadata })).toMatchObject({
        papel: "automatico",
        autor: "Mensagem automática",
      });
    }
    expect(linhaDe({ direction: "outbound", sent_via: "automation", body: "x" }).papel).toBe("automatico");
  });

  it("mensagem de sistema é do sistema, em qualquer direção", () => {
    expect(linhaDe({ type: "system", body: "conversa transferida" }).papel).toBe("sistema");
    expect(linhaDe({ direction: "outbound", sent_via: "system", body: "x" }).papel).toBe("sistema");
  });
});

describe("linhasDoHistorico: ordem e horário", () => {
  const embaralhadas = [
    msg({ id: "m3", sent_at: "2026-09-01T12:05:00.000Z", body: "terceira" }),
    msg({ id: "m1", sent_at: "2026-09-01T12:00:00.000Z", body: "primeira" }),
    msg({ id: "m2b", sent_at: "2026-09-01T12:02:00.000Z", body: "segunda b" }),
    msg({ id: "m2a", sent_at: "2026-09-01T12:02:00.000Z", body: "segunda a" }),
  ];

  it("ordena pelo instante, com o id desempatando", () => {
    expect(linhasDoHistorico(conversa, embaralhadas, { t }).map((l) => l.id)).toEqual(["m1", "m2a", "m2b", "m3"]);
  });

  it("horário no fuso pedido: 12:00Z é 09:00 em São Paulo e 08:00 em Manaus", () => {
    const horarios = (fuso?: string) => linhasDoHistorico(conversa, embaralhadas, { t, fuso }).map((l) => l.horario);
    expect(horarios("America/Sao_Paulo")[0]).toBe("01/09/2026 09:00");
    expect(horarios("America/Manaus")[0]).toBe("01/09/2026 08:00");
    // Virada de dia: 01:30Z de 02/09 ainda é 01/09 à noite em São Paulo.
    expect(
      linhasDoHistorico(conversa, [msg({ id: "x", sent_at: "2026-09-02T01:30:00.000Z", body: "boa noite" })], {
        t,
        fuso: "America/Sao_Paulo",
      })[0]!.horario,
    ).toBe("01/09/2026 22:30");
  });

  it("fuso inválido não derruba a exportação: cai no padrão", () => {
    expect(linhasDoHistorico(conversa, embaralhadas, { t, fuso: "Marte/Olimpo" })[0]!.horario).toBe("01/09/2026 09:00");
  });
});

describe("linhasDoHistorico: o que cada linha diz", () => {
  const textoDe = (m: Omit<Partial<MensagemParaPdf>, "id" | "sent_at">) =>
    linhasDoHistorico(conversa, [msg({ id: "m", sent_at: "2026-09-01T12:00:00.000Z", ...m })], { t })[0]!;

  it("documento é citado pelo nome do arquivo, sem conteúdo", () => {
    const linha = textoDe({
      type: "document",
      body: null,
      media_mime: "application/pdf",
      media_storage_path: "org/conv/m.pdf",
      metadata: { media_filename: "exame-de-sangue.pdf" },
    });
    expect(linha.texto).toBe("[Documento: exame-de-sangue.pdf]");
  });

  it("documento sem nome guardado, imagem, vídeo, figurinha e localização viram rótulo de tipo", () => {
    expect(textoDe({ type: "document" }).texto).toBe("[Documento]");
    expect(textoDe({ type: "image", body: "olha a mancha" }).texto).toBe("[Imagem]\nolha a mancha");
    expect(textoDe({ type: "video" }).texto).toBe("[Vídeo]");
    expect(textoDe({ type: "sticker" }).texto).toBe("[Figurinha]");
    expect(textoDe({ type: "location" }).texto).toBe("[Localização]");
  });

  it("caminho do Storage e URL da mídia nunca aparecem", () => {
    const linha = textoDe({ type: "image", media_storage_path: "org-secreta/conv/arquivo.jpg" });
    expect(linha.texto).not.toContain("org-secreta");
  });

  it("áudio leva a transcrição só quando pronta, e dita como automática", () => {
    expect(textoDe({ type: "audio", media_derived_status: "ready", media_derived_text: "estou com dor" }).texto).toBe(
      "[Áudio]\nTranscrição automática (pode conter erros): estou com dor",
    );
    expect(textoDe({ type: "audio", media_derived_status: "failed", media_derived_text: "lixo" }).texto).toBe("[Áudio]");
  });

  it("texto derivado de IMAGEM (leitura automática de exame) não entra", () => {
    const linha = textoDe({ type: "image", media_derived_status: "ready", media_derived_text: "hemoglobina 9,1" });
    expect(linha.texto).toBe("[Imagem]");
  });

  it("cartão de contato sai como nome e telefone, não como vCard cru", () => {
    const linha = textoDe({
      type: "contact",
      body: "BEGIN:VCARD\nVERSION:3.0\nFN:Dra. Paula\nTEL;waid=5527988887777:+55 27 98888-7777\nEND:VCARD",
    });
    expect(linha.texto).toContain("[Contato compartilhado: Dra. Paula");
    expect(linha.texto).not.toContain("BEGIN:VCARD");
  });

  it("apagada pelo autor fica como linha, sem o texto e sem o anexo", () => {
    const linha = textoDe({ type: "image", body: "o que a pessoa apagou", revoked_at: "2026-09-01T12:10:00.000Z" });
    expect(linha.texto).toBe("Mensagem apagada pelo autor.");
  });

  it("editada é marcada", () => {
    expect(textoDe({ body: "amanhã às 10h", edited_at: "2026-09-01T12:10:00.000Z" }).texto).toBe("amanhã às 10h (editada)");
  });

  it("envio que falhou é dito na linha: o paciente não recebeu", () => {
    expect(textoDe({ direction: "outbound", sent_via: "user", status: "failed", body: "x" }).ressalva).toBe(
      "não enviada: o envio falhou",
    );
    expect(textoDe({ direction: "outbound", sent_via: "user", status: "queued", body: "x" }).ressalva).toBe(
      "envio não confirmado",
    );
    expect(textoDe({ direction: "outbound", sent_via: "user", status: "read", body: "x" }).ressalva).toBeNull();
    expect(textoDe({ status: "failed", body: "x" }).ressalva).toBeNull();
  });

  it("nada da metadata é impresso (traços, citações, chamadas de ferramenta da IA)", () => {
    const linha = textoDe({
      direction: "outbound",
      sent_via: "ai",
      body: "posso ajudar",
      metadata: { ai_actor_id: "agente-1", citations: [{ trecho: "segredo interno" }], tool_calls: ["crm_x"] },
    });
    expect(JSON.stringify(linha)).not.toMatch(/segredo interno|crm_x|agente-1/);
  });

  it("emoji e símbolo que a fonte do PDF não desenha saem do texto; acento fica", () => {
    expect(textoDe({ body: "Obrigada, doutora! 😊🙏 Até amanhã – às 10h…" }).texto).toBe(
      "Obrigada, doutora!  Até amanhã - às 10h...",
    );
    expect(textoDe({ body: "😊" }).texto).toBe("[Mensagem sem texto]");
  });

  it("mensagem gigante é cortada com aviso na própria linha", () => {
    const linha = textoDe({ body: "a".repeat(LIMITE_DE_CARACTERES_POR_MENSAGEM + 500) });
    expect(linha.texto.length).toBeLessThan(LIMITE_DE_CARACTERES_POR_MENSAGEM + 200);
    expect(linha.texto).toContain("[texto cortado");
  });

  it("contato anonimizado sai com o rótulo anônimo", () => {
    const anonimo: ConversaParaPdf = {
      ...conversa,
      contato: { name: "Cliente Anonimizado #7", display_name: "Cliente Anonimizado #7", phone_number: null },
    };
    const [linha] = linhasDoHistorico(anonimo, [msg({ id: "m", sent_at: "2026-09-01T12:00:00.000Z", body: "[mensagem anonimizada]" })], { t });
    expect(linha).toMatchObject({ autor: "Cliente Anonimizado #7", texto: "[mensagem anonimizada]" });
  });
});

describe("montarPdfDaConversa: o arquivo", () => {
  const mensagens = [
    msg({ id: "m3", sent_at: "2026-09-01T12:05:00.000Z", direction: "outbound", sent_via: "user", sent_by_user_id: ANA, status: "read", body: "Terceira, da equipe" }),
    msg({ id: "m1", sent_at: "2026-09-01T12:00:00.000Z", body: "Primeira, do paciente" }),
    msg({ id: "m2", sent_at: "2026-09-01T12:02:00.000Z", direction: "outbound", sent_via: "ai", status: "sent", body: "Segunda, da IA", metadata: { ai_actor_id: "a" } }),
  ];
  const opcoes = { t, exportadoPor: "Carlos Gerente", nomesDosUsuarios, geradoEm: "2026-10-03T15:30:00.000Z" };

  it("é um PDF, com cabeçalho da clínica, contato, canal, período, quem exportou, aviso e as mensagens em ordem", async () => {
    const pdf = await montarPdfDaConversa(db(ORG), ORG_ID, conversa, mensagens, opcoes);
    if (!pdf.ok) throw new Error(pdf.motivo);

    expect(pdf.buffer.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(pdf.nomeDoArquivo).toBe("historico-conversa-jose-da-silva-2026-10-03.pdf");
    expect(pdf.linhas).toBe(3);

    const texto = (await extractPdfText(pdf.buffer)).replace(/\s+/g, " ");
    expect(texto).toContain("Clínica Bem Viver");
    expect(texto).toContain("Histórico da conversa");
    expect(texto).toContain("José da Silva");
    expect(texto).toContain("WhatsApp");
    expect(texto).toContain("Período: 01/09/2026 09:00 a 01/09/2026 09:05");
    expect(texto).toContain("Mensagens: 3");
    expect(texto).toContain("Exportado por: Carlos Gerente em 03/10/2026 12:30");
    expect(texto).toContain("America/Sao_Paulo");
    expect(texto).toContain("contém dados pessoais");
    expect(texto).toContain("Clínica Bem Viver LTDA");
    expect(texto).toContain("página 1 de 1");

    expect(texto).toContain("José da Silva · 01/09/2026 09:00 · recebida");
    expect(texto).toContain("Assistente virtual (IA) · 01/09/2026 09:02 · enviada");
    expect(texto).toContain("Ana Souza (equipe) · 01/09/2026 09:05 · enviada");
    const [p1, p2, p3] = ["Primeira, do paciente", "Segunda, da IA", "Terceira, da equipe"].map((s) => texto.indexOf(s));
    expect(p1).toBeGreaterThan(0);
    expect(p1!).toBeLessThan(p2!);
    expect(p2!).toBeLessThan(p3!);

    // Sem travessão em texto fixo do documento.
    expect(texto).not.toMatch(/[–—]/);
  });

  it("o fuso do documento é o da ORGANIZAÇÃO", async () => {
    const pdf = await montarPdfDaConversa(db({ ...ORG, timezone: "America/Manaus" }), ORG_ID, conversa, mensagens, opcoes);
    if (!pdf.ok) throw new Error(pdf.motivo);
    const texto = (await extractPdfText(pdf.buffer)).replace(/\s+/g, " ");
    expect(texto).toContain("José da Silva · 01/09/2026 08:00 · recebida");
    expect(texto).toContain("America/Manaus");
  });

  it("o aviso de corte só aparece quando a rota diz que cortou", async () => {
    const AVISO = "passa do limite de 500 mensagens";
    const inteira = await montarPdfDaConversa(db(ORG), ORG_ID, conversa, mensagens, opcoes);
    const cortada = await montarPdfDaConversa(db(ORG), ORG_ID, conversa, mensagens, { ...opcoes, truncada: true });
    if (!inteira.ok || !cortada.ok) throw new Error("render falhou");
    expect((await extractPdfText(inteira.buffer)).replace(/\s+/g, " ")).not.toContain(AVISO);
    expect((await extractPdfText(cortada.buffer)).replace(/\s+/g, " ")).toContain(AVISO);
  });

  it("conversa sem mensagem ainda gera um documento que diz isso", async () => {
    const pdf = await montarPdfDaConversa(db(ORG), ORG_ID, conversa, [], opcoes);
    if (!pdf.ok) throw new Error(pdf.motivo);
    expect(await extractPdfText(pdf.buffer)).toContain("Nenhuma mensagem nesta conversa.");
  });

  it("organização ilegível não derruba: cai na marca e no fuso padrão", async () => {
    const pdf = await montarPdfDaConversa(db(null), ORG_ID, conversa, mensagens, opcoes);
    if (!pdf.ok) throw new Error(pdf.motivo);
    const texto = (await extractPdfText(pdf.buffer)).replace(/\s+/g, " ");
    expect(texto).toContain("Marca da Instalação");
    expect(texto).toContain("01/09/2026 09:00");
  });
});
