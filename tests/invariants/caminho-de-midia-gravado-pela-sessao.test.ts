/**
 * 0382 (CRM-1) — CAMINHO DE ARQUIVO GRAVÁVEL PELA SESSÃO E ASSINADO PELA SERVICE ROLE.
 *
 * Auditoria de 17/10. As rotas de mídia (`/messages/[id]/media`) e de foto
 * (`/contacts/[id]/avatar`) leem o caminho com a sessão e o assinam com a
 * service role. `messages.media_storage_path` e `contacts.avatar_storage_path`
 * eram texto livre para a sessão: um caminho de outra conversa ou de outra
 * organização gravado na própria linha virava link assinado. As rotas conferem
 * o caminho (testes de rota); este arquivo prova a segunda camada, no banco:
 *
 *   - mensagem: na escrita com sessão, caminho novo é `{org}/{conversa}/{arquivo}`
 *     da própria linha (a regra de `isMediaPathOwnedBy`);
 *   - contato: a sessão não grava foto (quem grava é o cron, com service role).
 *
 * A nota interna tem a mesma trava desde a 0319
 * (`nota-interna-anexo-da-propria-conversa.test.ts`).
 *
 * Como foi conferido que nasce VERMELHO: contra o baseline sem a 0382, as
 * escritas da sessão passavam (erro nulo).
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_CONTACT_1,
  GOV_CONV_CLAIM,
  GOV_CONV_UNASSIGNED,
  GOV_ORG,
  GOV_SESSION,
  seedGov,
  sql,
  writeCountAs,
  writeErrorAs,
} from "./gov-helpers";

const id = (n: number) => `b0e0b000-0382-4000-8000-${String(n).padStart(12, "0")}`;

const OUTRA_ORG = id(900);
const MINHA = id(1);
const LEGADA = id(2);
const CAMINHO_LEGADO = `legado/${id(3)}.jpg`;
const DA_CONVERSA = `${GOV_ORG}/${GOV_CONV_UNASSIGNED}/out-${id(4)}.jpg`;

const MIDIA = "midia_da_mensagem_fora_da_conversa";
const FOTO = "foto_do_contato_so_o_servidor";

const caminhoDe = (m: string) =>
  sql(`select coalesce(media_storage_path, '(nenhum)') from public.messages where id = '${m}';`);

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.messages
      (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, body, sent_via, media_storage_path)
    values
      ('${MINHA}', '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', '${GOV_SESSION}', '${GOV_CONTACT_1}', 'image', 'outbound', 'sent', null, 'user', null),
      ('${LEGADA}', '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', '${GOV_SESSION}', '${GOV_CONTACT_1}', 'image', 'inbound', 'received', null, 'user', '${CAMINHO_LEGADO}');
  `);
});

describe("0382 — a sessão não aponta a mensagem para arquivo fora da conversa dela", () => {
  it.each([
    ["de outra organização", `${OUTRA_ORG}/${GOV_CONV_UNASSIGNED}/x.jpg`],
    ["de outra conversa", `${GOV_ORG}/${GOV_CONV_CLAIM}/x.jpg`],
    ["que sai da conversa com ..", `${GOV_ORG}/${GOV_CONV_UNASSIGNED}/../${GOV_CONV_CLAIM}/x.jpg`],
  ])("UPDATE com caminho %s (antes → passava)", (_nome, caminho) => {
    const erro = writeErrorAs(
      GOV_AGENT_A,
      `update public.messages set media_storage_path = '${caminho}' where id = '${MINHA}'`,
    );
    expect(erro, "a sessão gravou um caminho fora da conversa").not.toBeNull();
    expect(erro).toContain(MIDIA);
    expect(caminhoDe(MINHA)).toBe("(nenhum)");
  });

  it("INSERT com o arquivo de outra organização (antes → passava)", () => {
    const erro = writeErrorAs(
      GOV_AGENT_A,
      `insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, media_storage_path)
       values ('${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', '${GOV_SESSION}', '${GOV_CONTACT_1}', 'image', 'outbound', 'sending', 'user', '${OUTRA_ORG}/c/x.jpg')`,
    );
    expect(erro).toContain(MIDIA);
  });
});

describe("0382 — a sessão não grava a foto do contato", () => {
  it("UPDATE da foto para outro arquivo (antes → passava)", () => {
    const erro = writeErrorAs(
      GOV_AGENT_A,
      `update public.contacts set avatar_storage_path = '${OUTRA_ORG}/avatars/x.jpg' where id = '${GOV_CONTACT_1}'`,
    );
    expect(erro).toContain(FOTO);
    expect(sql(`select coalesce(avatar_storage_path, '(nenhum)') from public.contacts where id = '${GOV_CONTACT_1}';`)).toBe(
      "(nenhum)",
    );
  });
});

describe("0382 — o que tinha de continuar funcionando", () => {
  it("o envio grava o arquivo da própria conversa (é o que a rota faz)", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, media_storage_path)
         values ('${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', '${GOV_SESSION}', '${GOV_CONTACT_1}', 'image', 'outbound', 'sending', 'user', '${DA_CONVERSA}')`,
      ),
    ).toBe(1);
  });

  it("atualizar o status de mensagem com caminho antigo não confere de novo o caminho", () => {
    expect(writeCountAs(GOV_AGENT_A, `update public.messages set status = 'received' where id = '${LEGADA}'`)).toBe(1);
    expect(caminhoDe(LEGADA)).toBe(CAMINHO_LEGADO);
  });

  it("o servidor (service role / motor) grava o caminho que quiser", () => {
    sql(`update public.messages set media_storage_path = '${GOV_ORG}/${GOV_CONV_UNASSIGNED}/${MINHA}.jpg' where id = '${MINHA}';`);
    sql(`update public.contacts set avatar_storage_path = '${GOV_ORG}/avatars/${GOV_CONTACT_1}.jpg' where id = '${GOV_CONTACT_1}';`);
    expect(caminhoDe(MINHA)).toBe(`${GOV_ORG}/${GOV_CONV_UNASSIGNED}/${MINHA}.jpg`);
  });

  it("a sessão edita o contato com foto sem tocar nela, e zera a foto (anonimização)", () => {
    expect(
      writeCountAs(GOV_AGENT_A, `update public.contacts set display_name = 'Outro nome' where id = '${GOV_CONTACT_1}'`),
    ).toBe(1);
    expect(
      writeCountAs(GOV_AGENT_A, `update public.contacts set avatar_storage_path = null where id = '${GOV_CONTACT_1}'`),
    ).toBe(1);
  });
});
