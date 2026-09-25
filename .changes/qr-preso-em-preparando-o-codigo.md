---
impacto: nada_mudou
secao: corrigido
titulo: A tela do QR não fica mais presa em "Preparando o código…"
---

Ao reconectar um número cuja credencial foi revogada pelo celular, o botão
**Gerar novo QR** só aparecia se a sondagem pegasse a sessão num estado de falha.
Quando o serviço entrava em laço, esse instante quase nunca era pego e a tela
ficava em "Preparando o código…" para sempre, sem saída.

Agora, passados 30 segundos sem o código aparecer, a tela oferece o novo
pareamento de qualquer jeito e explica a causa provável. O relógio só corre
enquanto o QR nunca apareceu: depois que ele está na tela, nada é forçado.

Nada a fazer, vale assim que a atualização sobe.
