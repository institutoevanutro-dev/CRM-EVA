---
impacto: nada_mudou
secao: corrigido
titulo: O MCP passa a ter teto de chamadas por token, por organização e para escrita
---

O endereço que as ferramentas de IA externas usam (`/api/mcp`) não limitava quantas vezes um token válido chamava as ferramentas; um agente em laço podia disparar mensagens de WhatsApp sem parar.

Agora cada token faz até 60 chamadas por minuto, a organização até 600 e cada token até 30 nas ferramentas que alteram dados. Passando do teto, a chamada é recusada antes de a ferramenta rodar, a resposta diz quando tentar de novo e a recusa fica no log de auditoria. A IA do próprio sistema não passa por esse teto. Sem Redis, a contagem é feita na memória de cada processo.

Portado do projeto original (DeskcommCRM PR 1446 de @Alencaf).
