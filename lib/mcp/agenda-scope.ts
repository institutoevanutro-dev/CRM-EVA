/**
 * O funil que o Prontuário alimenta (chave "remarcar"): listar funis e etapas,
 * criar/atualizar o lead e movê-lo de etapa. Nada de contatos, conversas ou envio.
 */
const FUNIL_DO_PRONTUARIO: Record<string, "mcp:read" | "mcp:write"> = {
  crm_list_pipelines: "mcp:read",
  crm_list_stages: "mcp:read",
  crm_create_lead: "mcp:write",
  crm_update_lead: "mcp:write",
  crm_move_lead_stage: "mcp:write",
};

/** Uma chave da agenda nunca recebe permissão implícita para outra tool MCP. */
export function hasMcpToolScope(
  scopes: readonly string[],
  toolName: string,
  required: "mcp:read" | "mcp:write",
): boolean {
  if (scopes.includes(required)) return true;
  return (toolName === "crm_list_appointments" && required === "mcp:read" && scopes.includes("agenda:read")) ||
    (toolName === "crm_reschedule_appointment" && required === "mcp:write" && scopes.includes("agenda:reschedule")) ||
    // Só abre a tool; quem decide que é só "Realizado" é o handler (migration 0401).
    (toolName === "crm_set_appointment_outcome" && required === "mcp:write" && scopes.includes("agenda:outcome")) ||
    (FUNIL_DO_PRONTUARIO[toolName] === required && scopes.includes("prontuario:funil"));
}
