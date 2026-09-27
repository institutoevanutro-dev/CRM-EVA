/**
 * Sobe a Conta EvaLink falsa numa porta FIXA, como processo próprio, para o
 * `playwright.config.ts` (segundo `webServer`). O `.env.e2e` aponta `CONTA_URL`
 * para esta porta, e o servidor do CRM busca nela o JWKS e troca o código.
 */
import { sobeContaFalsa } from "./conta-falsa";

const porta = Number(process.env.CONTA_FALSA_PORTA ?? "47812");
void sobeContaFalsa(porta);
