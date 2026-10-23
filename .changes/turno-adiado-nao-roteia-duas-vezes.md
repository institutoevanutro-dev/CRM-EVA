---
impacto: nada_mudou
secao: corrigido
titulo: A mensagem que chega fora do horário do agente não conta duas vezes no roteamento
---
Quando a mensagem do paciente chegava fora do horário de funcionamento do agente (por exemplo, 19h para um agente que atende das 8h às 18h), a resposta era adiada para a abertura, mas o roteador já tinha escolhido o agente e gravado essa decisão. Na abertura, o roteador escolhia de novo e a mesma mensagem aparecia duas vezes nos números de roteamento da tela de evolução da IA. Agora a decisão da primeira vez é reaproveitada: uma mensagem, uma decisão. A resposta ao paciente não muda. Nada a fazer na atualização.

Portado do projeto original (DeskcommCRM, PR #3215 de @webtecnica).
