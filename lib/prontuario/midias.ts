/**
 * Exames do WhatsApp → Prontuário: a regra de ELEGIBILIDADE num lugar só.
 *
 * Usada pelas duas rotas que o Prontuário lê (`GET /api/v1/prontuario/
 * contacts/{id}/midias` e `GET /api/v1/prontuario/midias/{id}`) e pela checagem
 * do botão (`POST /api/v1/messages/{id}/prontuario`). SQL parametrizado pelo
 * pool (`getRequestPool`), para a regra ser provada contra Postgres real com
 * duas organizações em `tests/invariants/exames-do-whatsapp-no-prontuario.test.ts`.
 *
 * Elegível: inbound, `image`/`document`, não apagada, conversa 1:1 do WhatsApp,
 * contato vivo (não anonimizado, não unido), mime normalizado entre os cinco.
 * A lista só traz mídia já guardada; `buscarMidia` também devolve a pendente
 * de verdade (para o 409), mas nunca a que o worker desistiu.
 *
 * Sem import de `@/lib/supabase/admin` nem de `@/lib/env`: só o pool recebido.
 */
import type pg from "pg";

export const MIMES_DA_LISTA = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"] as const;

/** Teto da lista. ponytail: sem cursor (o Prontuário só lê `data`); paginar se um contato passar disso. */
const TETO_DA_LISTA = 200;

export type LinhaDeMidia = {
  message_id: string;
  contact_id: string;
  conversation_id: string;
  sent_at: Date;
  mime: string;
  /** `bigint` chega do `pg` como texto. */
  size_bytes: string | number | null;
  filename: string | null;
  type: string;
  storage_path: string | null;
  pendente: boolean;
};

export type ItemDaLista = {
  message_id: string;
  received_at: string;
  mime: string;
  size_bytes: number;
  filename: string | null;
  kind: "documento" | "imagem";
};

const MIME_SQL = "lower(btrim(split_part(coalesce(m.media_mime, ''), ';', 1)))";

const COLUNAS = `
select m.id as message_id, m.contact_id, m.conversation_id, m.sent_at,
       ${MIME_SQL} as mime,
       m.media_size_bytes as size_bytes,
       nullif(btrim(m.metadata->>'media_filename'), '') as filename,
       m.type, m.media_storage_path as storage_path,
       (m.media_storage_path is null) as pendente`;

/** O predicado comum. `$1` = organização, `$2` = os mimes. */
const ELEGIVEL = `
from public.messages m
join public.conversations c on c.id = m.conversation_id and c.organization_id = m.organization_id
join public.contacts k on k.id = m.contact_id and k.organization_id = m.organization_id
where m.organization_id = $1
  and m.direction = 'inbound'
  and m.type in ('image', 'document')
  and m.revoked_at is null
  and c.channel = 'whatsapp' and c.is_group = false
  and coalesce(c.group_chat_id, '') not like '%@g.us'
  and k.is_anonymized = false and k.is_merged_into is null
  and ${MIME_SQL} = any($2::text[])`;

export async function listarMidiasDoContato(
  pool: Pick<pg.Pool, "query">,
  p: { organizationId: string; contactId: string; dias: number },
): Promise<LinhaDeMidia[]> {
  const r = await pool.query<LinhaDeMidia>(
    `${COLUNAS} ${ELEGIVEL}
       and m.contact_id = $3
       and m.sent_at >= now() - make_interval(days => $4::int)
       and m.media_storage_path is not null and m.media_size_bytes is not null
     order by m.sent_at desc, m.id desc
     limit ${TETO_DA_LISTA}`,
    [p.organizationId, MIMES_DA_LISTA, p.contactId, p.dias],
  );
  return r.rows;
}

export async function buscarMidia(
  pool: Pick<pg.Pool, "query">,
  p: { organizationId: string; messageId: string },
): Promise<LinhaDeMidia | null> {
  const r = await pool.query<LinhaDeMidia>(
    `${COLUNAS} ${ELEGIVEL}
       and m.id = $3
       and ((m.media_storage_path is not null and m.media_size_bytes is not null)
            or (m.media_storage_path is null and m.media_url is not null and m.metadata->>'media_status' is null))`,
    [p.organizationId, MIMES_DA_LISTA, p.messageId],
  );
  return r.rows[0] ?? null;
}

/** A forma exata do contrato, com as regras de `itemDoCrm` do Prontuário. */
export function itemDaLista(l: LinhaDeMidia): ItemDaLista {
  return {
    message_id: String(l.message_id).toLowerCase(),
    received_at: new Date(l.sent_at).toISOString(),
    mime: l.mime,
    size_bytes: Number(l.size_bytes),
    // O Prontuário recusa o item inteiro com nome acima de 500.
    filename: l.filename ? l.filename.slice(0, 500) : null,
    kind: l.type === "image" ? "imagem" : "documento",
  };
}
