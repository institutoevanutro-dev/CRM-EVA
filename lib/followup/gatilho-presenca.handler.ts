import type { EventHandler } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";

export const followupGatilhoPresencaHandler: EventHandler = {
  key: "followup-gatilho-presenca.v1",
  // Falta (`outcome_confirmed`) e presença (`attended`, migration 0373)
  // confirmadas pela equipe: fn_appointment_recover escolhe o gatilho pelo tipo.
  events: ["appointment.outcome_confirmed", "appointment.attended"],
  async handle(row) {
    const { data, error } = await createAdminClient().rpc("fn_appointment_recover", {
      p_org: row.organization_id,
      p_event: row.id,
    });
    return {
      consumer_key: this.key,
      status: error ? "error" : "ok",
      detail: error ? `Recuperação indisponível: ${error.message}` : String(data?.result),
    };
  },
};
