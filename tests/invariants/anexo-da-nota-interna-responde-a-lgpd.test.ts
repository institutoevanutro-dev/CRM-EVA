/**
 * O ANEXO DA NOTA INTERNA (DeskcommCRM #1863, F3) nas TRÊS garras de LGPD — colunas,
 * cascata de redação e fila de purga — executando contra o Postgres de verdade.
 *
 * Por que não basta o teste unitário: `tests/unit/lgpd-exporta-o-que-redige`
 * lê o baseline e o coletor no DISCO e mostra que as duas pontas batem em
 * texto. O perigo desta F3 é outro — é o ARQUIVO. Um caminho que a cascata
 * esqueça de enfileirar não aparece em teste nenhum que leia código: ele vira
 * órfão, e o expurgo apaga com auditoria dizendo que a redação ocorreu.
 * Ela só aparece quando o caminho passa pelo banco.
 *
 * Portado do projeto original (DeskcommCRM PR 1883 de @webtecnica; lá, 0303).
 * O caso da fila de purga (`fn_enfileirar_midia_vencida`) ficou de fora: a
 * função não existe neste fork.
 *
 * Casos, um por modo de falha:
 *   - a coluna de mídia existe em `conversation_notes` (a tripla da 0303);
 *   - o bucket `internal-media` existe, fechado, com o limite dos 50 MB — e o
 *     `whatsapp-media` continua onde estava;
 *   - a cascata redige o texto, ZERA o ponteiro e enfileira o arquivo com
 *     `bucket = 'internal-media'` — e NUNCA com `whatsapp-media`.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { GOV_CONTACT_1, GOV_CONV_UNASSIGNED, GOV_ORG, columnExists, lastLine, seedGov, sql } from "./gov-helpers";

// A conversa TEM de ser do CONTATO da cascata: `fn_lgpd_cascade_redact_contact`
// percorre `conversation_id in (select id from conversations where contact_id = …)`,
// e `GOV_CONV_AGENT_B` é do CONTACT_2 — medido: com ela a 6d não achava linha
// nenhuma e os três casos de redação devolviam a nota intacta.
const CONVERSA = GOV_CONV_UNASSIGNED;
const CONTATO = GOV_CONTACT_1;
const ORG = GOV_ORG;

const NOTA_COM_ANEXO = "43830000-0000-4000-8000-000000000001";
const PEDIDO = "43830000-0000-4000-8000-00000000000f";

const ANEXO = `${ORG}/${CONVERSA}/note-print.png`;

const conta = (q: string) => Number(lastLine(sql(q)));

/** Linha na fila de purga, com o bucket explicitado — o detalhe que importa. */
const naFila = (bucket: string, caminho: string) =>
  conta(
    `select count(*) from storage_redaction_queue where bucket = '${bucket}' and object_path = '${caminho}'`,
  );

function objeto(bucket: string, nome: string, idadeDias: number): string {
  return `insert into storage.objects (bucket_id, name, metadata, created_at)
          values ('${bucket}', '${nome}', '{"size": 1000}'::jsonb, now() - interval '${idadeDias} days');`;
}

function nota(id: string, caminho: string, texto: string): string {
  return `insert into conversation_notes (id, organization_id, conversation_id, body, media_storage_path, media_mime, media_size_bytes)
          values ('${id}', '${ORG}', '${CONVERSA}', '${texto}', '${caminho}', 'image/png', 1000);`;
}

beforeEach(() => {
  seedGov();
  sql(`
    insert into storage.buckets (id, name) values ('whatsapp-media', 'whatsapp-media')
      on conflict (id) do nothing;
    insert into storage.buckets (id, name, public, file_size_limit)
      values ('internal-media', 'internal-media', false, 52428800)
      on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;
    delete from storage_redaction_queue where organization_id = '${ORG}';
    delete from storage.objects where name like '${ORG}/%';
    delete from conversation_notes where organization_id = '${ORG}';
    -- O pedido de LGPD é o dono da linha da fila: storage_redaction_queue tem
    -- FK para lgpd_requests, e a 6d enfileira sob o p_request_id que a
    -- cascata recebe. Sem esta linha a RPC estoura em request_id_fkey —
    -- medido, é o erro que os dois casos de redação devolviam.
    insert into lgpd_requests (id, organization_id, request_type, source, scope, due_at)
      values ('${PEDIDO}', '${ORG}', 'redact', 'manual', 'contact', now() + interval '15 days')
      on conflict (id) do nothing;
    -- a cascata é irreversível em contacts; sem este reset o segundo caso
    -- desta suíte encurtaria em already_anonymized e mediria nada. Neste fork
    -- o gatilho fn_contacts_anonimizacao_irreversivel barra a volta — o reset
    -- é do FIXTURE, então desliga os gatilhos só para este update.
    set session_replication_role = replica;
    update contacts set is_anonymized = false, anonymized_at = null
      where id = '${CONTATO}' and organization_id = '${ORG}';
    set session_replication_role = default;
  `);
});

describe("anexo da nota interna — colunas e bucket (0303)", () => {
  it("conversation_notes tem as três colunas de mídia", () => {
    expect(columnExists("conversation_notes", "media_storage_path")).toBe(true);
    expect(columnExists("conversation_notes", "media_mime")).toBe(true);
    expect(columnExists("conversation_notes", "media_size_bytes")).toBe(true);
  });

  it("o bucket internal-media existe, é privado e limita 50 MB", () => {
    // `boolean::text` devolve 'false' (não 'f') — medido no Postgres do gate.
    expect(sql(`select public::text || '|' || file_size_limit from storage.buckets where id = 'internal-media';`)).toBe(
      "false|52428800",
    );
  });

  it("o whatsapp-media continua intacto ao lado dele", () => {
    expect(
      lastLine(sql(`select count(*) from storage.buckets where id in ('whatsapp-media', 'internal-media');`)),
    ).toBe("2");
  });
});

describe("anexo da nota interna — cascata de redação", () => {
  it("redige o texto, zera o ponteiro e enfileira com o bucket internal-media", () => {
    sql(`${nota(NOTA_COM_ANEXO, ANEXO, "print do erro")}${objeto("internal-media", ANEXO, 5)}`);

    const saida = lastLine(sql(`select public.fn_lgpd_cascade_redact_contact('${ORG}', '${CONTATO}', '${PEDIDO}');`));
    expect(JSON.parse(saida).already_anonymized).toBe(false);

    // texto e ponteiro: os três degraus do card não podem sobrar ligados
    expect(
      sql(`select body || '|' || coalesce(media_storage_path, 'NULL') from conversation_notes where id = '${NOTA_COM_ANEXO}';`),
    ).toBe("[nota interna anonimizada]|NULL");

    // o arquivo foi para a fila COM O BUCKET CERTO e sob o pedido
    expect(
      lastLine(sql(`select count(*) from storage_redaction_queue
                     where bucket = 'internal-media' and object_path = '${ANEXO}'
                       and request_id = '${PEDIDO}' and status = 'pending';`)),
    ).toBe("1");

    // e NUNCA como mídia de whatsapp-media — enfileirar ali apontaria a
    // remoção para um bucket onde o arquivo não está (falha medida na F3)
    expect(naFila("whatsapp-media", ANEXO)).toBe(0);
  });

  it("a fila fica com o caminho da nota mesmo depois de zerado o ponteiro", () => {
    sql(`${nota(NOTA_COM_ANEXO, ANEXO, "print do erro")}${objeto("internal-media", ANEXO, 5)}`);
    sql(`select public.fn_lgpd_cascade_redact_contact('${ORG}', '${CONTATO}', '${PEDIDO}');`);

    // O ponteiro já não existe mais; a única coisa que liga o titular àquela
    // mídia é a fila. Se o INSERT viesse DEPOIS do UPDATE (ou fosse perdido
    // numa falha da RPC), o arquivo continuaria lá para sempre.
    expect(
      lastLine(sql(`select count(*) from storage_redaction_queue where bucket = 'internal-media' and object_path = '${ANEXO}';`)),
    ).toBe("1");
    expect(lastLine(sql(`select count(*) from conversation_notes where media_storage_path is not null;`))).toBe("0");
  });

  it("nota sem anexo não gera fila — só texto não é arquivo", () => {
    sql(nota(NOTA_COM_ANEXO, "ignored", "só texto"));
    sql(`update conversation_notes set media_storage_path = null where id = '${NOTA_COM_ANEXO}';`);
    sql(`select public.fn_lgpd_cascade_redact_contact('${ORG}', '${CONTATO}', '${PEDIDO}');`);

    expect(lastLine(sql(`select count(*) from storage_redaction_queue;`))).toBe("0");
    expect(
      lastLine(sql(`select body from conversation_notes where id = '${NOTA_COM_ANEXO}';`)),
    ).toBe("[nota interna anonimizada]");
  });
});
