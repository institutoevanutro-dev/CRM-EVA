---
impacto: capacidade_nova
secao: adicionado
titulo: Dá para levar os follow-ups em andamento para a versão nova do fluxo
---

Uma inscrição de follow-up fica presa à versão do fluxo em que começou, então publicar textos novos (com `{{primeiro_nome}}`, por exemplo) só alcançava quem entrasse depois. A API ganhou `POST /api/v1/ai/followup-flows/{id}/migrar-inscricoes` (só administrador), com corpo `{ "dry_run": true | false }`: leva as inscrições vivas (ativas, aguardando resposta ou pausadas) para a versão ativa, mas só as seguras — o passo em que cada uma está precisa existir na versão nova com o mesmo tipo e, se for espera ou prazo de resposta, com o mesmo tempo. O status e a hora do próximo passo não mudam e nada é enviado na hora. Cada inscrição levada ganha o evento `version_migrated`, e a execução fica na auditoria (`followup_flow.enrollments_migrated`). Com `dry_run: true` só mostra a contagem por versão de origem, com o motivo das que não são seguras. Quem opera o servidor pode rodar o mesmo pelo contêiner do worker: `pnpm exec tsx scripts/migrar-inscricoes-de-versao.ts --org <uuid> --pointer <uuid> [--executar]`. Sem mudança no banco.
