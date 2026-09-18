import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { ok, fail } from "@/lib/api/wrappers";
import { condicoesDaBuscaDeContato } from "@/lib/contacts/busca";

/**
 * GET /api/v1/agenda/vinculos — quem será atendido numa marcação.
 *
 * A busca por texto usa `condicoesDaBuscaDeContato` (lib/contacts/busca.ts), a
 * mesma régua da lista de contatos. Antes ela era só `name.ilike` e devolvia
 * vazio para todo contato vindo do WhatsApp (nome em `display_name`, `name`
 * nulo) — o cabeçalho daquele arquivo tem a medição.
 *
 * A resposta leva `display_name` e `phone_number` porque a tela precisa deles
 * para chamar a pessoa pelo nome (`rotuloDoContato`); sem isso, um contato sem
 * `name` virava uma opção EM BRANCO no seletor.
 */
export async function GET(req: Request) {
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "agenda" });
  if (!auth.ok) return auth.response;
  const input = z
    .object({ contact_id: z.uuid().optional(), q: z.string().max(100).optional() })
    .safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!input.success) return fail("validation_failed", "Confira o contato.", 422, { requestId });
  const db = await createClient();
  let contacts = db
    .from("contacts")
    .select("id,name,display_name,phone_number")
    .eq("organization_id", auth.org.orgId)
    .eq("is_anonymized", false)
    // Contato mesclado não é marcável: o vínculo iria para o registro morto,
    // e o lembrete, para um telefone que já não é o dele. Mesmo corte da lista.
    .is("is_merged_into", null)
    .order("display_name", { ascending: true, nullsFirst: false })
    .order("name", { ascending: true, nullsFirst: false })
    .limit(30);
  if (input.data.contact_id) contacts = contacts.eq("id", input.data.contact_id);
  else if (input.data.q) {
    const condicoes = condicoesDaBuscaDeContato(input.data.q);
    if (condicoes.length > 0) contacts = contacts.or(condicoes.join(","));
  }
  const result = await contacts;
  if (result.error)
    return fail("internal_error", "Não foi possível carregar os contatos.", 500, { requestId });
  const conversations =
    input.data.contact_id && result.data.length
      ? await db
          .from("conversations")
          .select("id,created_at,status")
          .eq("organization_id", auth.org.orgId)
          .eq("contact_id", input.data.contact_id)
          .eq("is_group", false)
          .order("created_at", { ascending: false })
          .limit(30)
      : { data: [], error: null };
  if (conversations.error)
    return fail("internal_error", "Não foi possível carregar as conversas.", 500, { requestId });
  return ok({ contacts: result.data, conversations: conversations.data }, { requestId });
}
