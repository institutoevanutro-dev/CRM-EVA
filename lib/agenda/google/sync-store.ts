import type { SupabaseClient } from "@supabase/supabase-js";
import type { Json } from "@/lib/database.types";
import { z } from "zod";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { meetingStateSchema } from "./meet";
import { claimSchema, baseSchema, conflictSchema, cursorSchema, pendingSchema } from "./sync-model";

export const appointmentSnapshotSchema = z.object({
  meeting_allowed_types: z.array(z.string()).nullable().default(null),
  meeting_state: meetingStateSchema.default("not_requested"),
  meeting_request_id: z.uuid().nullable().default(null),
  meeting_requested_at: z.string().nullable().default(null),
  meeting_received_at: z.string().nullable().default(null),
  meeting_next_attempt_at: z.string().nullable().default(null),
  meeting_url: z.string().nullable().default(null),
  id: z.uuid(),
  organization_id: z.uuid(),
  owner_user_id: z.uuid(),
  contact_id: z.uuid().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  starts_at: z.string(),
  ends_at: z.string(),
  time_zone: z.string(),
  status: z.enum(["pending", "confirmed", "completed", "no_show", "cancelled"]),
  location_kind: z.enum(["in_person", "phone", "whatsapp", "video_link", "google_meet"]),
  location_details: z.string().nullable(),
  guest_email: z.string().nullable(),
  revision: z.string(),
  google_local_revision: z.string(),
  google_synced_local_revision: z.string(),
  google_connection_id: z.uuid().nullable(),
  google_calendar_id: z.string().nullable(),
  google_event_id: z.string().nullable(),
  google_etag: z.string().nullable(),
  google_base_projection: baseSchema.nullable(),
  google_conflict: conflictSchema.nullable(),
  google_pending_write: pendingSchema.nullable(),
  claim: claimSchema,
});
export type AppointmentSnapshot = z.infer<typeof appointmentSnapshotSchema>;
/** Resolve só o nome publicável, sem copiar dados pessoais para o checkpoint. */
export async function appointmentForGoogle<
  A extends {
    organization_id: string;
    contact_id: string | null;
    status: string;
  },
>(db: SupabaseClient, a: A): Promise<A & { contact_name: string | null }> {
  if (!a.contact_id || a.status === "cancelled") return { ...a, contact_name: null };
  const { data, error } = await db
    .from("contacts")
    .select("name,display_name")
    .eq("organization_id", a.organization_id)
    .eq("id", a.contact_id)
    .maybeSingle();
  if (error) throw new Error("Não foi possível consultar o nome do contato para a agenda.");
  return { ...a, contact_name: nomeDoContato(data) };
}
export const calendarSnapshotSchema = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  connection_id: z.uuid(),
  external_calendar_id: z.string(),
  time_zone: z.string().nullable(),
  claim: claimSchema,
  sync_cursor: cursorSchema.nullable(),
});
export type CalendarSnapshot = z.infer<typeof calendarSnapshotSchema>;
export interface CalendarFence {
  id: string;
  claim: z.infer<typeof claimSchema>;
  cursor: z.infer<typeof cursorSchema>;
}
/** RPCs server-only: contexto original sempre vai no argumento, nunca refetch do token. */
export async function googleRpc(
  db: SupabaseClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { data, error } = await db.rpc(name, args as Record<string, Json>);
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return data;
}
export function expectedAppointment(a: AppointmentSnapshot, calendarFence?: CalendarFence) {
  return {
    meeting_request_id: a.meeting_request_id,
    claim: a.claim,
    revision: a.revision,
    local_revision: a.google_local_revision,
    connection_id: a.google_connection_id,
    calendar_id: a.google_calendar_id,
    event_id: a.google_event_id,
    ...(calendarFence ? { calendar_fence: calendarFence } : {}),
  };
}
