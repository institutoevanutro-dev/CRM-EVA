import { randomUUID } from "node:crypto";
import { reconcileAppointment } from "@/lib/agenda/google/sync-executor";
import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { appointmentSnapshotSchema, appointmentForGoogle } from "@/lib/agenda/google/sync-store";
import { paraEventoDoGoogle, type AgendamentoParaGoogle } from "@/lib/agenda/google/evento";
import {
  checkpoint,
  compare,
  delta,
  localProjection,
  remoteProjection,
} from "@/lib/agenda/google/sync-model";

const appointment = {
  id: "22222222-2222-4222-8222-222222222222",
  organization_id: "11111111-1111-4111-8111-111111111111",
  contact_id: "33333333-3333-4333-8333-333333333333",
  title: "Consulta",
  starts_at: "2026-10-29T21:00:00Z",
  ends_at: "2026-10-29T22:00:00Z",
  time_zone: "America/Sao_Paulo",
  status: "confirmed" as const,
  location_kind: "in_person" as const,
};
function database(
  contact: { name: string | null; display_name: string | null } | null,
  failed = false,
) {
  const requests: URL[] = [];
  const db = createClient("https://test.invalid", "synthetic-key", {
    auth: { persistSession: false, autoRefreshToken: false, storageKey: randomUUID() },
    global: {
      fetch: async (input) => {
        requests.push(new URL(String(input)));
        return new Response(
          JSON.stringify(failed ? { message: "synthetic failure" } : contact ? [contact] : []),
          {
            status: failed ? 400 : 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    },
  });
  return { db, requests };
}
describe("nome do contato na sincronização Google", () => {
  it("consulta somente o contato da organização e usa o nome cadastrado antes do perfil", async () => {
    const { db, requests } = database({ name: "  Pessoa Exemplo  ", display_name: "Apelido" });
    const named = await appointmentForGoogle(db, appointment);
    expect(paraEventoDoGoogle(named).summary).toBe("Pessoa Exemplo — Consulta");
    expect(requests[0]!.pathname).toBe("/rest/v1/contacts");
    expect(requests[0]!.searchParams.get("organization_id")).toBe(
      `eq.${appointment.organization_id}`,
    );
    expect(requests[0]!.searchParams.get("id")).toBe(`eq.${appointment.contact_id}`);
    expect(appointment.title).toBe("Consulta");
  });
  it("usa o nome de exibição quando não existe nome cadastrado", async () => {
    const { db } = database({ name: null, display_name: "Pessoa do Perfil" });
    expect(paraEventoDoGoogle(await appointmentForGoogle(db, appointment)).summary).toBe(
      "Pessoa do Perfil — Consulta",
    );
  });
  it("bloqueios não consultam contato nem recebem um paciente fictício", async () => {
    const { db, requests } = database(null);
    const block = await appointmentForGoogle(db, {
      ...appointment,
      contact_id: null,
      title: "Horário bloqueado",
    });
    expect(paraEventoDoGoogle(block).summary).toBe("Horário bloqueado");
    expect(requests).toHaveLength(0);
  });
  it("contato sem nome não publica identificador técnico", async () => {
    const { db } = database({ name: "Contato 123456789", display_name: null });
    expect(paraEventoDoGoogle(await appointmentForGoogle(db, appointment)).summary).toBe(
      "Consulta",
    );
  });
  it("falha na consulta não publica título sem nome como se tivesse sincronizado", async () => {
    const { db } = database(null, true);
    await expect(appointmentForGoogle(db, appointment)).rejects.toThrow();
  });
  it("cancelamento não depende da consulta ao contato", async () => {
    const { db, requests } = database(null, true);
    expect(
      (await appointmentForGoogle(db, { ...appointment, status: "cancelled" as const })).status,
    ).toBe("cancelled");
    expect(requests).toHaveLength(0);
  });
  it("evento existente recebe só o título e converge sem nova escrita", () => {
    const original: AgendamentoParaGoogle = appointment;
    const remote = { id: "existing-id", ...paraEventoDoGoogle(original), etag: '"old"' };
    const oldLocal = localProjection(original);
    const oldRemote = remoteProjection(remote, oldLocal, null);
    const base = checkpoint(
      null,
      oldLocal,
      oldRemote,
      ["title", "description", "location", "guest"],
      true,
    );
    const named = { ...appointment, contact_name: "Pessoa Exemplo" };
    const local = localProjection(named);
    const decision = compare(base, local, remoteProjection(remote, local, base));
    expect(decision).toMatchObject({ kind: "publish", shared: false, groups: ["title"] });
    const patch = delta(named, remote, base, decision.groups, decision.shared);
    expect(patch).toEqual({ summary: "Pessoa Exemplo — Consulta" });
    const updated = remoteProjection({ ...remote, ...patch }, local, base);
    expect(compare(checkpoint(base, local, updated, ["title"], false), local, updated).kind).toBe(
      "converged",
    );
  });
});

it.each([false, true])(
  "executor publica nome e mantém um único evento (novo=%s)",
  async (newEvent) => {
    const body = paraEventoDoGoogle(appointment);
    let remote = newEvent ? null : { ...body, id: "existing-id", etag: '\"1\"' };
    const oldLocal = localProjection(appointment);
    const base = remote
      ? checkpoint(
          null,
          oldLocal,
          remoteProjection(remote, oldLocal, null),
          ["title", "description", "location", "guest"],
          true,
        )
      : null;
    const snapshot = appointmentSnapshotSchema.parse({
      ...appointment,
      owner_user_id: appointment.organization_id,
      description: null,
      location_details: null,
      guest_email: null,
      revision: "1",
      google_local_revision: "1",
      google_synced_local_revision: "1",
      google_connection_id: appointment.organization_id,
      google_calendar_id: "destination",
      google_event_id: "existing-id",
      google_etag: remote?.etag ?? null,
      google_base_projection: base,
      google_conflict: null,
      google_pending_write: newEvent ? { reservation: true } : null,
      claim: { token: appointment.id, epoch: "1", lease_until: "2027-01-01T00:00:00Z" },
    });
    const db = createClient("https://test.invalid", "synthetic-key", {
      auth: { persistSession: false, autoRefreshToken: false, storageKey: randomUUID() },
      global: {
        fetch: async (input, init) => {
          const url = new URL(String(input));
          if (url.pathname === "/rest/v1/contacts") {
            expect(url.searchParams.get("organization_id")).toBe(
              `eq.${appointment.organization_id}`,
            );
            return Response.json([{ name: "Pessoa Exemplo", display_name: "Perfil" }]);
          }
          expect(url.pathname).toBe("/rest/v1/rpc/fn_google_appointment");
          const args = JSON.parse(String(init?.body));
          if (args.p_action === "commit") {
            const r = args.p_args.result;
            if (r.base) snapshot.google_base_projection = r.base;
            if (r.etag) snapshot.google_etag = r.etag;
            if (r.clear_pending) snapshot.google_pending_write = null;
            if (r.ack) snapshot.google_synced_local_revision = snapshot.google_local_revision;
          }
          if (args.p_action === "error") throw new Error("unexpected sync error");
          return Response.json(snapshot);
        },
      },
    });
    const writes: { method: string; url: string; body: Record<string, unknown> }[] = [];
    const transport: typeof fetch = async (input, init) => {
      const url = String(input);
      if (init?.method === "GET" && !new URL(url).pathname.includes("/events/"))
        return Response.json({ id: "destination" });
      if (init?.method === "GET")
        return remote ? Response.json(remote) : Response.json({}, { status: 404 });
      const patch = JSON.parse(String(init?.body));
      const method = String(init?.method);
      writes.push({ method, url, body: patch });
      if (method === "PATCH") {
        expect(new URL(url).pathname).toMatch(/events\/existing-id$/);
        expect((init?.headers as Record<string, string>)["If-Match"]).toBe(remote?.etag);
      } else {
        expect(remote).toBeNull();
        expect(patch.id).toBe("existing-id");
      }
      remote = { ...body, ...remote, ...patch, id: "existing-id", etag: '\"2\"' };
      return Response.json(remote);
    };
    expect(
      await reconcileAppointment(db, appointment.organization_id, appointment.id, {
        token: "synthetic",
        transport,
      }),
    ).toBe("processed");
    expect(remote).toMatchObject({ id: "existing-id", summary: "Pessoa Exemplo — Consulta" });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.method).toBe(newEvent ? "POST" : "PATCH");
    if (!newEvent) expect(writes[0]!.body).toEqual({ summary: "Pessoa Exemplo — Consulta" });
    expect(
      await reconcileAppointment(db, appointment.organization_id, appointment.id, {
        token: "synthetic",
        transport,
      }),
    ).toBe("unchanged");
    expect(writes).toHaveLength(1);
  },
);
