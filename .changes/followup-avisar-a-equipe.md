---
impacto: capacidade_nova
secao: adicionado
titulo: Follow-up ganha a caixa "Avisar a equipe"
---

O construtor de follow-up tem uma caixa nova, "Avisar a equipe", com um texto curto (até 140 caracteres, obrigatório para publicar). Quando o fluxo passa por ela, abre um aviso na Central com link para a conversa do contato, e quem ligou o push no celular é avisado, como nos avisos em que a IA passa a conversa para uma pessoa. Nada é enviado ao cliente, e o fluxo segue para a próxima caixa. Uso típico: depois de "sem resposta" no pós-consulta, avisar a equipe para mandar um áudio ao paciente. O histórico da inscrição mostra o passo como "Avisou a equipe na Central".

A atualização acrescenta um tipo de aviso ao banco (migration 0406), aplicado pelo `update.sh` como de costume.
