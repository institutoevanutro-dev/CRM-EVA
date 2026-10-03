---
impacto: nada_mudou
secao: corrigido
titulo: A exportação de dados do titular inclui a transcrição e o texto extraído da mídia
---

O arquivo do direito de acesso (`data.json` e `report.pdf`) dizia que a mensagem tinha
mídia, mas não trazia a transcrição do áudio nem o texto extraído da imagem, que é o que
a IA leu. Agora traz `media_derived_text` de cada mensagem do titular; o binário continua
fora. Na prévia da solicitação a transcrição aparece mascarada, como o corpo da mensagem.
Portado do DeskcommCRM PR 2020 de @webtecnica.
