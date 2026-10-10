---
impacto: nada_mudou
secao: corrigido
titulo: Vídeo e arquivo acima de 10 MB voltam a ser enviados pela conversa
---
Enviar pelo "+" da conversa um vídeo ou arquivo maior que 10 MB falhava com "Unable to read upload.", porque o servidor cortava o envio em 10 MB, embora o limite anunciado seja 50 MB. Agora o corte acompanha o limite de 50 MB.
