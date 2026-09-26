---
impacto: exige_acao
secao: adicionado
titulo: Comentários do Instagram entram no CRM, com regras e resposta automática
---

Um comentário num post do Instagram vira uma fila no CRM: casando uma palavra
configurada, o sistema manda um Direct para quem comentou e responde no
próprio comentário, sem toque humano. Sem regra, um classificador de segurança
decide: comentário obviamente seguro (elogio) recebe uma resposta gerada pela
IA no jeito do dono; qualquer coisa fora disso, preço, sintoma, agendamento,
reclamação, cai na aba nova "Comentários", esperando alguém revisar antes de
publicar.

## Requer atenção

O app do Instagram passou a pedir uma permissão nova
(`instagram_business_manage_comments`):

- Reconecte os dois perfis do Instagram em Configurações › Conexões. A conta
  precisa autorizar o escopo novo antes de a captura de comentário funcionar;
  sem reconectar, o Instagram continua recebendo Direct normalmente.
- A Meta ainda precisa liberar Acesso Avançado para `comments` neste app. Até
  lá, a captura de comentário não roda em produção, mesmo com o código já
  publicado.
