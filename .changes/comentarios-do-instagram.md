---
impacto: exige_acao
secao: adicionado
titulo: Comentários do Instagram entram no CRM, com regras e resposta automática
---

Comentário num post vira fila no CRM. Casando uma palavra configurada, o
sistema manda um Direct para quem comentou e responde no próprio comentário.
Sem regra, um classificador decide: elogio recebe resposta da IA no jeito do
dono; preço, sintoma, agendamento e reclamação caem na aba "Comentários"
esperando revisão.

## Requer atenção

O app do Instagram passa a pedir a permissão `instagram_business_manage_comments`:

- Reconecte os dois perfis em Configurações › Conexões. Sem reconectar, a
  captura de comentário não funciona (o Direct continua normal).
- A Meta precisa liberar Acesso Avançado para `comments`. Até lá a captura
  não roda em produção, mesmo com o código publicado.
