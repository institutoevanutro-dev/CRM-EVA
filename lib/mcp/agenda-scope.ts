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
    (toolName === "crm_set_appointment_outcome" && required === "mcp:write" && scopes.includes("agenda:outcome"));
}
