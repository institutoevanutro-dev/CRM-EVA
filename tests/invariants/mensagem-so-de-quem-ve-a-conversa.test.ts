/**
 * 0382 (CRM-2) — SÓ QUEM VÊ A CONVERSA REESCREVE OU APAGA A MENSAGEM DELA.
 *
 * Auditoria de 17/10. `messages_update` e `messages_delete` só exigiam a
 * organização (e papel `agent`, pela restritiva da 0299). No modo padrão de
 * visibilidade ("as suas e as sem dono"), o atendente A não vê a conversa do
 * atendente B, e mesmo assim reescrevia e apagava as mensagens dela pelo
 * PostgREST, sem linha na auditoria.
 *
 * Como foi conferido que nasce VERMELHO: contra o baseline sem a 0382, as
 * escritas de A na conversa de B devolviam 1 linha.
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_CONTACT_1,
  GOV_CONTACT_2,
  GOV_CONV_AGENT_B,
  GOV_CONV_UNASSIGNED,
  GOV_MANAGER,
  GOV_ORG,
  GOV_SESSION,
  countAs,
  seedGov,
  sql,
  writeCountAs,
  writeErrorAs,
} from "./gov-helpers";

const id = (n: number) => `a0e0a000-0382-4000-8000-${String(n).padStart(12, "0")}`;

const DE_B_TEXTO = id(1);
const DE_B_ECO = id(2);
const DE_B_ECO_2 = id(3);
const SEM_DONO_TEXTO = id(4);
const SEM_DONO_ECO = id(5);
const SEM_DONO_MOVER = id(6);

const corpo = (m: string) => sql(`select body from public.messages where id = '${m}';`);
const existe = (m: string) => sql(`select count(*) from public.messages where id = '${m}';`) === "1";

beforeAll(() => {
  seedGov();
  const linha = (m: string, conv: string, contato: string, via: string) =>
    `('${m}', '${GOV_ORG}', '${conv}', '${GOV_SESSION}', '${contato}', 'text', 'outbound', 'sent', 'original', '${via}')`;
  sql(`
    insert into public.messages
      (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, body, sent_via)
    values
      ${linha(DE_B_TEXTO, GOV_CONV_AGENT_B, GOV_CONTACT_2, "user")},
      ${linha(DE_B_ECO, GOV_CONV_AGENT_B, GOV_CONTACT_2, "external_device")},
      ${linha(DE_B_ECO_2, GOV_CONV_AGENT_B, GOV_CONTACT_2, "external_device")},
      ${linha(SEM_DONO_TEXTO, GOV_CONV_UNASSIGNED, GOV_CONTACT_1, "user")},
      ${linha(SEM_DONO_ECO, GOV_CONV_UNASSIGNED, GOV_CONTACT_1, "external_device")},
      ${linha(SEM_DONO_MOVER, GOV_CONV_UNASSIGNED, GOV_CONTACT_1, "user")};
  `);
});

describe("0382 — quem não vê a conversa não mexe nas mensagens dela", () => {
  // As escritas vão SEM `where` e sem `returning`, de propósito: com um filtro
  // ou um RETURNING o Postgres aplica também a policy de SELECT e a linha
  // invisível já ficava de fora. Sem eles só valem as policies de UPDATE e
  // DELETE, que é o que o PostgREST alcança com um corpo sem filtro de coluna.
  it("CONTROLE DE CENÁRIO: A não lê a conversa de B, B lê", () => {
    expect(countAs(GOV_AGENT_A, `select count(*) from public.messages where id = '${DE_B_TEXTO}';`)).toBe(0);
    expect(countAs(GOV_AGENT_B, `select count(*) from public.messages where id = '${DE_B_TEXTO}';`)).toBe(1);
  });

  it("A reescreve todas as mensagens da organização (antes → as de B também)", () => {
    expect(writeErrorAs(GOV_AGENT_A, `update public.messages set body = 'reescrita'`)).toBeNull();
    expect(corpo(DE_B_TEXTO)).toBe("original");
    expect(corpo(DE_B_ECO)).toBe("original");
    expect(corpo(SEM_DONO_TEXTO)).toBe("reescrita");
  });

  it("A leva uma mensagem da conversa que vê para a de B (já barrado pela leitura; fica de guarda)", () => {
    const erro = writeErrorAs(
      GOV_AGENT_A,
      `update public.messages set conversation_id = '${GOV_CONV_AGENT_B}' where id = '${SEM_DONO_MOVER}'`,
    );
    expect(erro).toContain("row-level security");
    expect(sql(`select conversation_id from public.messages where id = '${SEM_DONO_MOVER}';`)).toBe(
      GOV_CONV_UNASSIGNED,
    );
  });
});

describe("0382 — o que tinha de continuar funcionando", () => {
  it("quem vê a conversa atualiza a mensagem dela (status do envio)", () => {
    expect(
      writeCountAs(GOV_AGENT_A, `update public.messages set status = 'sent' where id = '${SEM_DONO_TEXTO}'`),
    ).toBe(1);
    expect(
      writeCountAs(GOV_AGENT_B, `update public.messages set status = 'sent' where id = '${DE_B_TEXTO}'`),
    ).toBe(1);
  });

  it("o gestor, que vê todas, atualiza mensagem da conversa de B", () => {
    expect(
      writeCountAs(GOV_MANAGER, `update public.messages set status = 'sent' where id = '${DE_B_TEXTO}'`),
    ).toBe(1);
  });

  it("o dono da conversa apaga o eco do próprio envio (removerEcoDoProprioEnvio)", () => {
    expect(
      writeCountAs(
        GOV_AGENT_B,
        `delete from public.messages where organization_id = '${GOV_ORG}' and conversation_id = '${GOV_CONV_AGENT_B}'
           and sent_via = 'external_device' and id = '${DE_B_ECO_2}'`,
      ),
    ).toBe(1);
  });

  it("o atendente continua enviando (INSERT) na conversa que vê", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, body, sent_via)
         values ('${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', '${GOV_SESSION}', '${GOV_CONTACT_1}', 'text', 'outbound', 'sending', 'oi', 'user')`,
      ),
    ).toBe(1);
  });
});

// Por último: apaga de verdade.
describe("0382 — apagar com sessão é só o eco, e só na conversa que se vê", () => {
  it("A apaga todas as mensagens da organização (antes → todas, inclusive as de B)", () => {
    expect(writeErrorAs(GOV_AGENT_A, `delete from public.messages`)).toBeNull();
    // A única que saiu é o eco da conversa que A vê.
    expect(existe(SEM_DONO_ECO)).toBe(false);
    for (const m of [DE_B_TEXTO, DE_B_ECO, SEM_DONO_TEXTO, SEM_DONO_MOVER]) expect(existe(m)).toBe(true);
  });

  it("nem o gestor, que vê tudo, apaga mensagem que não é eco (antes → 1)", () => {
    expect(writeErrorAs(GOV_MANAGER, `delete from public.messages`)).toBeNull();
    for (const m of [DE_B_TEXTO, SEM_DONO_TEXTO, SEM_DONO_MOVER]) expect(existe(m)).toBe(true);
    expect(existe(DE_B_ECO)).toBe(false);
  });
});
