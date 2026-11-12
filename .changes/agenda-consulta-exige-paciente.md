---
impacto: capacidade_nova
secao: adicionado
titulo: Consulta na agenda exige paciente
---

Um compromisso de tipo que é consulta passa a exigir o paciente: sem ele, a Agenda avisa ao lado do campo ("Escolha o paciente para marcar uma consulta.") e não marca, e a API (`POST /api/v1/agenda/agendamentos`) e a IA recebem a recusa `422 patient_required`. Isso evita consulta que abre no Prontuário como "Paciente não informado". Cada tipo ganhou o interruptor **Exige paciente** em Configurações › Agenda, ligado por padrão, inclusive nos tipos que já existem. O tipo **Reunião** que vem de fábrica (e todo tipo da categoria Reunião que já existe) fica com o interruptor desligado. **Outros tipos usados para reunião interna precisam ter "Exige paciente" desligado à mão**, senão deixam de poder ser marcados sem paciente. Bloquear horário não muda. A atualização cria só uma coluna nova no banco (migration 0411).
