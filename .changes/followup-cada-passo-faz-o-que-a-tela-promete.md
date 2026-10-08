---
impacto: capacidade_nova
secao: corrigido
titulo: Follow-up, cada passo faz o que a tela promete
---

Vários passos do follow-up não faziam o que a tela mostrava. Agora fazem:

- **Condição "Desfecho do passo anterior".** A condição passa a ler a resposta
  que o passo "classificar a resposta" escolheu. Antes ela era ignorada, e uma
  regra "não é" mandava todos os contatos pelo mesmo caminho. Contato que ainda
  não foi classificado não entra mais na regra "não é".
- **Regra por número de etapas.** "Maior ou igual a 3" e parecidas passam a
  funcionar. Antes o número digitado era lido como texto e a regra nunca
  batia.
- **Passo "classificar a resposta".** O passo espera o cliente responder até o
  prazo configurado. Antes ele seguia como "sem resposta" segundos depois da
  mensagem. A resposta do cliente conta mesmo que o agente tenha respondido
  antes, e o histórico mostra "Esperando a resposta do cliente".
- **Histórico do follow-up em português claro.** O resultado aparece como
  frase ("Encerrado sem conversão", "Pediu para parar"), o contador se chama
  "Etapas executadas" e a falha diz que é uma nova tentativa automática do
  sistema, não um contato a mais com o cliente.
- **Duplicar e renomear um fluxo.** Na lista de follow-ups, cada fluxo ganhou
  os botões Renomear e Duplicar. A cópia nasce como rascunho, com o mesmo
  desenho e o mesmo gatilho, e não envia nada até ser publicada.
- **Follow-up pausado por atendimento humano.** Quando o atendimento humano
  termina, o passo que estava parado volta a enviar. Antes ele ficava preso e
  acabava marcado como falha.

Vale conferir os fluxos que usam a condição "Desfecho do passo anterior" com
"não é": alguns contatos podem passar a seguir por outro caminho.

Portado do projeto original (DeskcommCRM).
