import { execFileSync } from "node:child_process";

/**
 * Abre a janela anti-ban (0h–24h, domingo liberado) de TODOS os números da
 * organização do rig (ou da `orgId` dada). O texto fixo do follow-up passou a
 * respeitar a janela do número também pelo atalho, e o padrão é 7h–22h em
 * America/Sao_Paulo: sem isto, a spec que roda entre 22h e 7h BRT vê o passo
 * ADIADO e fica vermelha pela hora do CI. Mesma razão e mesmo efeito de
 * `garantirJanelaSempreAberta` (`scripts/seed-e2e-numero-conectado.ts`). O
 * adiamento em si é provado com relógio injetado (unit e invariante).
 */
export function abrirJanelaDeEnvio(orgId?: string): void {
  execFileSync(
    "npx",
    ["tsx", "scripts/e2e-followup-journey-helpers.ts", "abrir-janela-de-envio", ...(orgId ? [orgId] : [])],
    { stdio: "inherit" },
  );
}
