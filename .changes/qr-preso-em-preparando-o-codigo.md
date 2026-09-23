---
impacto: nada_mudou
secao: corrigido
titulo: A tela do QR não fica mais presa em "Preparando o código…"
---

Reconectando um número cuja credencial foi revogada pelo celular, a tela do QR só oferecia
**Gerar novo QR** — que é a única ação que resolve credencial revogada — quando a sondagem
pegava a sessão num estado de falha. Quando o serviço de WhatsApp entrava em laço
(`STARTING` → falha de conexão → parada forçada → `STARTING`), a sondagem quase nunca pegava
esse instante, e a tela ficava em "Preparando o código…" **para sempre**, sem nenhuma saída:
quem estava com o número fora do ar não tinha por onde continuar.

Era sorte, e deu os dois resultados no mesmo dia e na mesma instalação: num número o botão
apareceu normalmente, no outro a tela ficou mais de um minuto sem oferecer nada.

Agora, passados 30 segundos sem o código aparecer, a tela oferece o novo pareamento de
qualquer jeito, explicando que a causa provável é o número ter sido desvinculado pelo celular.
O relógio só corre enquanto o QR **nunca** apareceu — depois que ele está na tela, quem demora
é a pessoa pegando o celular, e nada é forçado. Sondagem que só dá erro (serviço de WhatsApp
fora do ar) também chega à saída, porque ali o beco sem saída é o mesmo.

Nada a fazer: vale assim que a atualização sobe.
