import type { Logger } from "@/lib/agent-engine/obs/logger";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { variantesDoItem } from "./esquemas";
import { tipoDaMidia } from "./envio";
import { hojeNaClinica, situacaoDaMidia } from "./termo";

export type MidiaDisponivel = { id: string; title: string; when_to_use: string; tags: string[] };

const LIMITE_NO_PROMPT = 30;

type Linha = MidiaDisponivel & {
  variants: unknown;
  contains_person: boolean;
  consent_signed_at: string | null;
  consent_expires_at: string | null;
  consent_revoked_at: string | null;
};

/** Itens da biblioteca que o agente pode mandar agora (mesma regra do handler de envio). */
export async function carregarMidiasProntas(
  db: Queryable,
  orgId: string,
  hoje: string = hojeNaClinica(),
  log?: Logger,
): Promise<MidiaDisponivel[]> {
  try {
    return await consultar(db, orgId, hoje);
  } catch (err) {
    // A biblioteca é opcional: falha de consulta não derruba o turno. Sem mensagem de erro (pode ter dado).
    log?.warn("biblioteca de mídias indisponível neste turno", {
      error: err instanceof Error ? err.name : "unknown",
    });
    return [];
  }
}

async function consultar(db: Queryable, orgId: string, hoje: string): Promise<MidiaDisponivel[]> {
  // ponytail: `limit 200` por título — item pronto além dos 200 primeiros fica invisível ao
  // agente. Se uma biblioteca passar disso, filtre a prontidão no SQL antes do limit.
  // to_char: a coluna `date` não depende do type parser do pg (Date em fuso local vs string).
  const { rows } = await db.query<Linha>(
    `select id, title, when_to_use, tags, variants, contains_person,
            to_char(consent_signed_at, 'YYYY-MM-DD') as consent_signed_at,
            to_char(consent_expires_at, 'YYYY-MM-DD') as consent_expires_at,
            consent_revoked_at
       from media_library_items
      where organization_id = $1
      order by title
      limit 200`,
    [orgId],
  );
  const prontas: MidiaDisponivel[] = [];
  for (const r of rows) {
    const variants = variantesDoItem(r.variants, orgId, r.id).filter((v) => tipoDaMidia(v.mime));
    if (situacaoDaMidia({ ...r, variants }, hoje) !== "pronta") continue;
    prontas.push({ id: r.id, title: r.title, when_to_use: r.when_to_use, tags: r.tags ?? [] });
    if (prontas.length === LIMITE_NO_PROMPT) break;
  }
  return prontas;
}

export function blocoDaBiblioteca(itens: MidiaDisponivel[]): string | null {
  if (itens.length === 0) return null;
  const uma = (t: string) => t.replace(/\s+/g, " ").trim();
  const linhas = itens.map(
    (i) => `- ${i.id} · ${uma(i.title)} · quando usar: ${uma(i.when_to_use)} · etiquetas: ${i.tags.map(uma).join(", ")}`,
  );
  return [
    "BIBLIOTECA DE MÍDIAS",
    'Você pode mandar UMA destas imagens ou vídeos por resposta com a ferramenta send_media, quando ajudar a pessoa a decidir. Escolha pelo "quando usar". Nunca diga que vai mandar algo que não está nesta lista.',
    ...linhas,
  ].join("\n");
}
