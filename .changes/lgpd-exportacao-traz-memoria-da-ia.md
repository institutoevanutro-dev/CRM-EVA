---
impacto: nada_mudou
secao: corrigido
titulo: A exportação de dados do titular inclui a memória e os registros da IA sobre ele
---

O arquivo do direito de acesso (`data.json`) passa a trazer as notas de memória da IA
(`lead_notes`), o nome e os argumentos das ferramentas que a IA chamou
(`ai_agent_runs.tool_calls`) e a próxima ação e a qualificação do funil (`lead_state`).
O resultado das ferramentas e o texto intermediário do modelo ficam de fora, porque podem
trazer dado de outros contatos. Portado do DeskcommCRM PR 1969 de @webtecnica.
