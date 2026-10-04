---
impacto: nada_mudou
secao: corrigido
titulo: O roteador de intenções passa a classificar a transcrição do áudio
---

Num roteador com `sticky` ligado, um áudio do cliente nunca chegava ao
classificador: o texto do turno vinha só da coluna `body`, que é vazia para
áudio, e a conversa ficava presa no agente anterior. Agora o áudio já
transcrito é classificado como qualquer texto; o áudio ainda sem transcrição
segue como antes e mantém o agente atual. Não é preciso fazer nada na instalação.

Portado do projeto original (DeskcommCRM PR 2082 de @webtecnica).
