// @vitest-environment node
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { renderLgpdPdf } from "@/lib/lgpd/pdf-renderer";
import type { ContactSnapshot, ExportPayload } from "@/lib/lgpd/export-collector";

/**
 * O PDF do titular traz o endereço, os campos personalizados e as propostas que
 * a IA fez para o cadastro — com o NOME do campo, sem CPF em claro e sem uma
 * segunda linha de CPF.
 *
 * Portado do DeskcommCRM original (commits cb2c95b08 e fe6f768ef, de
 * melgarafael) e adaptado: aqui o rótulo vem das definições de campo do funil
 * (não de roteiros), e o CPF não aparece nem no arquivo de dados.
 */

function payload(): ExportPayload {
  return {
    request_id: "3f2a9c10-0000-4000-8000-000000000001",
    organization_id: "8c1d4e20-0000-4000-8000-000000000002",
    organization_legal_name: "Bem Viver Servicos Medicos LTDA",
    organization_display_name: "MARCA_DO_REVENDEDOR_NAO_USAR",
    dpo_email: "encarregado@bemviver.test",
    generated_at: "2030-01-02T13:05:00Z",
    no_local_footprint: false,
    contact: null,
    consents: [],
    conversations: [],
    messages_count_total: 0,
    messages_recent: [],
    leads: [],
    orders: [],
    activities: [],
    appointments: [],
    tasks: [],
    webhook_captures: [],
    audit_log_extract: [],
    meeting_deliveries: [],
    appointment_notices: [],
    voice_calls: [],
    channel_identities: [],
    campaign_recipients: [],
    campaign_suppressions: [],
  };
}

function contato(over: Partial<ContactSnapshot> = {}): ContactSnapshot {
  return {
    id: "contato-1",
    name: "Lia",
    display_name: null,
    email: null,
    phone_number: "5531999990000",
    cpf_present: false,
    birthdate: null,
    is_blocked: false,
    is_anonymized: false,
    consent: null,
    tags: [],
    source: "whatsapp",
    source_metadata: null,
    created_at: "2030-01-02T13:05:00Z",
    last_activity_at: null,
    first_service_at: null,
    custom_fields: {},
    campos_legiveis: [],
    cpf_em_campo_personalizado: false,
    ...over,
  };
}

async function texto(data: ExportPayload): Promise<string> {
  const bytes = await renderLgpdPdf(data);
  const fonts =
    join(dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "standard_fonts") + sep;
  const task = getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: fonts });
  const document = await task.promise;
  try {
    const paginas: string[] = [];
    for (let n = 1; n <= document.numPages; n++) {
      const conteudo = await (await document.getPage(n)).getTextContent();
      paginas.push(conteudo.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    }
    return paginas.join("\n").replace(/\s+/g, " ");
  } finally {
    await task.destroy();
  }
}

it("o PDF lista o endereço e os campos personalizados pelo nome do campo", async () => {
  const data = payload();
  data.contact = contato({
    custom_fields: { endereco: "RUA-DAS-FLORES-100", convenio: "unimed" },
    campos_legiveis: [
      { rotulo: "Endereço", valor: "RUA-DAS-FLORES-100" },
      { rotulo: "Convênio", valor: "Unimed Vitória" },
    ],
  });

  const pdf = await texto(data);

  expect(pdf).toContain("Endereço e campos personalizados");
  for (const trecho of ["Endereço", "RUA-DAS-FLORES-100", "Convênio", "Unimed Vitória"]) expect(pdf).toContain(trecho);
  // O titular lê o nome do campo, não a chave técnica.
  expect(pdf).not.toContain("convenio");
});

it("CPF guardado em campo personalizado: o PDF diz que existe, uma vez só, e não mostra o número", async () => {
  const data = payload();
  data.contact = contato({
    cpf_em_campo_personalizado: true,
    campos_legiveis: [{ rotulo: "Endereço", valor: "Rua A, 1" }],
    // O coletor entrega `custom_fields` já sem CPF. Este caso põe um de
    // propósito para provar que o PDF imprime só os campos legíveis — nunca o
    // objeto cru, onde um CPF que escapasse do coletor apareceria.
    custom_fields: { endereco: "Rua A, 1", cpf: "52998224725" },
  });

  const pdf = await texto(data);

  expect(pdf).toContain("Informado em campo personalizado (valor não exibido)");
  expect(pdf.match(/CPF:/g)).toHaveLength(1);
  expect(pdf).not.toContain("52998224725");
});

it("com o CPF do cadastro E um em campo personalizado, a linha do CPF continua sendo uma só", async () => {
  const data = payload();
  data.contact = contato({ cpf_present: true, cpf_em_campo_personalizado: true });

  const pdf = await texto(data);

  expect(pdf).toContain("Armazenado (criptografado)");
  expect(pdf).not.toContain("Informado em campo personalizado");
  expect(pdf.match(/CPF:/g)).toHaveLength(1);
});

it("o PDF mostra o que a IA propôs para o cadastro, com o trecho da conversa", async () => {
  const data = payload();
  data.contact = contato();
  data.contact_field_proposals = [
    {
      id: "p-1",
      campo: "phone_number",
      valor_proposto: "+5527988887777",
      valor_anterior: "+5527911112222",
      conversation_id: null,
      trecho: "TRECHO-DA-CONVERSA",
      status: "pending",
      proposed_at: "2030-01-02T13:05:00Z",
      decided_at: null,
      motivo_recusa: null,
    },
  ];

  const pdf = await texto(data);

  expect(pdf).toContain("Dados sugeridos pela IA para o seu cadastro");
  expect(pdf).toContain("Telefone");
  expect(pdf).toContain("+5527988887777");
  expect(pdf).toContain("+5527911112222");
  expect(pdf).toContain("TRECHO-DA-CONVERSA");
});

it("sem campos nem propostas, o PDF não ganha seção vazia", async () => {
  const data = payload();
  data.contact = contato();

  const pdf = await texto(data);

  expect(pdf).not.toContain("Endereço e campos personalizados");
  expect(pdf).not.toContain("Dados sugeridos pela IA");
});
