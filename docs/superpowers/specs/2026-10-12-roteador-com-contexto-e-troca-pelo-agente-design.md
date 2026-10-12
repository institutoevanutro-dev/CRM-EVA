# Roteador com contexto e troca pelo agente: desenho

Data: 12/10/2026. Continua o desenho `2026-10-11-multiagentes-e-roteador-design.md`. Motivo: o teste em conversa real de 12/10 reprovou.

> **Estado: código construído (12/10/2026), versão ainda não instalada.** O que foi construído difere deste desenho em três pontos e ganhou regras nas revisões. Tudo está na seção 11, que vale sobre as seções 3, 4 e 10 onde elas discordarem. Plano: `docs/superpowers/plans/2026-10-12-roteador-contexto-e-passagem.md`.

## 1. O que o teste mostrou

Conversa de teste (número da lista, 12/10, 11h12 a 11h19):

| Mensagem da paciente | Quem atendeu | Problema |
|---|---|---|
| "Gostaria de agendar uma consulta com o Dr. André" | Agente 2 (Paciente) | A agenda dela tem um procedimento realizado. O roteador leu "já é paciente". O agente perguntou se era primeira consulta. |
| "Primeira consulta" | Agente 2 | O roteador não trocou para o agente 1. |
| "Preciso emagrecer", "Presencial", "Jardim Camburi" | Agente 2 | Improvisou a primeira consulta sem o roteiro: sem abertura, sem a opção de R$490, sem cobrar o sinal. |
| "Quarta" em diante | Agente 5 (Recepção) | Resposta curta trocou o agente no meio. A Recepção abriu caso "para a recepção confirmar" em vez de marcar. |

Nada foi gravado na Agenda. O roteador foi desativado em seguida; os cinco agentes continuam publicados e sem receber conversa.

A bateria de 45 mensagens tinha passado (44 de 45, três rodadas iguais). Ela mede mensagem isolada, e os três defeitos só aparecem em conversa:

1. **O roteador julga cada mensagem sozinha.** O que a paciente disse duas mensagens antes não entra na decisão.
2. **Resposta curta troca de agente.** "Quarta", sem contexto, parece assunto de recepção.
3. **Agente fora do seu assunto improvisa.** A instrução "não conduza outro assunto" não segura o modelo quando a conversa continua chegando nele.

## 2. Objetivo

A escolha de quem COMEÇA a conversa é do roteador. A troca NO MEIO passa a ser, por regra, do agente que está atendendo, que é quem tem o contexto. O roteador só interrompe uma conversa em andamento para assuntos marcados como urgentes (queixa clínica).

Sucesso, medido em conversa real com número de teste e conversa zerada:

1. Os cinco caminhos do desenho anterior, do começo ao fim, cada um com o agente certo.
2. A conversa de 12/10 refeita: a paciente com procedimento no histórico diz "primeira consulta" e passa a ser atendida pelo agente 1, com o roteiro inteiro, sem precisar repetir nada.
3. Nenhuma resposta curta troca de agente.
4. Queixa clínica no meio de qualquer atendimento vai para o agente 4 na mesma mensagem.

## 3. As três mudanças de código

### 3.1 O agente passa a conversa para outro assunto

Todo agente que é membro do roteador ativo do canal ganha uma ação nova: **passar para outro assunto**. Ela recebe o assunto de destino (um dos outros assuntos daquele roteador) e um motivo curto.

O que acontece quando o agente usa a ação:

- A conversa passa a pertencer ao agente do assunto de destino.
- O agente que passou não envia texto nesse turno. A mesma mensagem da paciente é reprocessada pelo agente de destino, que responde. A paciente não percebe a troca e não precisa escrever de novo.
- Fica registrada a decisão: de quem, para quem, o motivo.

Travas:

- No máximo uma passagem por mensagem recebida. O agente de destino não pode passar de novo no mesmo turno; se ele também achar que não é com ele, responde como Recepção faria: pergunta o que a pessoa precisa.
- Destino sem versão publicada ou fora do roteador: a ação falha com erro claro para o agente, que segue atendendo.
- A ação só aparece para o agente quando o canal tem roteador ativo e o agente é membro dele. Fora disso nada muda.

### 3.2 O roteador para de trocar no meio, salvo assunto urgente

Modo novo de permanência, ligado por roteador (os roteadores existentes continuam como estão):

- Conversa sem agente atual: o roteador classifica e escolhe, como hoje.
- Conversa com agente atual: o roteador só troca se a mensagem for classificada, acima da certeza mínima, num assunto marcado como **interrompe**. Para qualquer outro assunto a conversa fica com o agente atual, e a troca, se for o caso, é dele (3.1).
- Quais assuntos interrompem é configuração do roteador. Neste canal: só queixa clínica.

Isso elimina a troca por resposta curta, porque "Quarta" nunca é classificada como queixa clínica.

### 3.3 O classificador vê a conversa

Junto com a mensagem e os fatos da agenda, o classificador recebe:

- as últimas mensagens da conversa (até 6, dos dois lados, cada uma cortada em 300 caracteres);
- o assunto atual da conversa, quando houver.

Serve para dois momentos: a primeira escolha quando a conversa já tem histórico recente, e a detecção de queixa clínica dita em mais de uma mensagem ("está doendo" depois de "fiz a aplicação ontem").

Regras: só mensagens do atendimento atual (a fronteira de atendimento que o CRM já usa para o histórico do agente); mesmas regras de privacidade dos fatos; sem a conversa disponível, classifica como hoje. O registro da versão diz que o trecho recente da conversa passa a ir ao provedor do classificador.

## 4. Mudanças menores que entram junto

- **Tela de teste do roteador:** aceita uma conversa simulada (mensagens anteriores e assunto atual), para a bateria testar "resposta curta no meio" e "queixa no meio" de verdade.
- **Reiniciar teste:** passa a apagar também qual agente estava atendendo a conversa. Hoje não apaga, e a conversa reiniciada continuaria com o agente anterior.
- **Fim do atendimento:** quando a conversa é fechada, o agente atual é esquecido, e a próxima conversa começa pelo roteador. No plano confiro se isso já acontece.

## 5. Mudanças de configuração (sem código, depois da versão instalada)

- **Descrições dos assuntos do Dr. André:** "já é paciente" passa a exigir consulta, retorno, acompanhamento ou teleconsulta realizados, ou consulta futura marcada. Procedimento realizado (implante, aplicação, massagem) não torna a pessoa paciente dele para efeito de roteiro. Foi o que levou a conversa de 12/10 ao agente errado na primeira mensagem.
- **Prompts dos cinco agentes:** sai o trecho "responda que vai ajudar e faça uma pergunta" e entra uma seção curta "quando passar para outro assunto", com os casos de cada agente (por exemplo, agente 2: a pessoa diz que é a primeira consulta; agente 5: o assunto ficou claro e é de outro agente).
- **Roteador do canal:** modo novo de permanência ligado, com queixa clínica como único assunto que interrompe.
- **Bateria:** ganha conversas, não só mensagens. No mínimo: a conversa de 12/10; resposta curta em cada etapa de uma marcação; queixa clínica no meio de cada um dos outros quatro atendimentos; pedido de humano; mudança explícita de assunto.

## 6. Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| Só dar contexto ao classificador (3.3 sozinha) | Melhora, mas a troca no meio continua sendo palpite de um modelo barato a cada mensagem. O teste de 12/10 mostrou que a mesma frase muda de resposta entre uma chamada e outra. |
| Só a ação de passar (3.1 sozinha) | Sem 3.2 o roteador continua desfazendo a decisão do agente na mensagem seguinte. |
| Voltar para um agente único | É o ponto de partida, com os erros que motivaram o trabalho. |
| Regra fixa por assunto no roteador (condição exata sobre a agenda) | Resolve a primeira escolha, não a troca no meio. Continua como passo futuro se a primeira escolha seguir errando. |

## 7. Riscos

- **Agente que não passa quando deveria.** A troca vira responsabilidade do agente, e ele pode insistir em atender. Mitigação: seção curta e específica em cada prompt, e a bateria de conversas cobre cada caso de passagem.
- **Agente que passa demais.** Mitigação: uma passagem por mensagem e destino restrito aos assuntos do roteador.
- **Custo e tempo.** Um turno com passagem roda dois agentes. Só acontece na mensagem em que há troca.
- **Mais conteúdo indo ao provedor do classificador.** Declarado no registro da versão.
- **Outras instalações.** Tudo é opcional por roteador: sem ligar o modo novo, o comportamento atual não muda. A ação de passar só existe onde há roteador ativo com o agente como membro.

## 8. Ordem de entrega

1. Código (3.1, 3.2, 3.3 e seção 4), em um PR, com testes e registro da versão.
2. Versão instalada pela Memória central.
3. Configuração da seção 5, com o roteador inativo.
4. Bateria de conversas na tela de teste.
5. Roteador ativo só para os números de teste; conversa real nos cinco caminhos e na conversa de 12/10.
6. Liberação para pacientes, com o OK do André.

## 9. Fora deste desenho

- Tela para ver, por conversa, qual agente atendeu cada mensagem e por quê. As decisões do roteador já ficam registradas; falta mostrá-las. Vale uma tarefa própria, porque teria encurtado o diagnóstico de 12/10.
- Agentes Confirmação, Isadora e Erick.
- Comparação com o Jev (a Memória central cuida).

## 10. Pontos a confirmar no plano

- Se fechar a conversa já esquece o agente atual.
- Onde a ação de passar se encaixa na lista de ferramentas do agente e no limite de ferramentas por agente.
- Como reprocessar a mesma mensagem com outro agente sem duplicar envio nem cobrança do turno.
- Se o registro de decisões do roteador comporta a passagem pelo agente sem mudança de banco.

## 11. O que foi construído (12/10/2026)

### 11.1 Fatos conferidos no código, que respondem a seção 10

- **Fechar a conversa já esquece o agente atual.** A reabertura (`fn_service_inbound`) e o gatilho `trg_service_stamp_status` zeram `active_ai_agent_id`. "Reiniciar teste" fecha a conversa, então a mensagem seguinte já começa pelo roteador. Os dois itens da seção 4 sobre isso não pediram código.
- **A configuração do roteador é livre e mesclada no PATCH.** O modo novo entrou em `ai_routers.config` (`permanencia: 'agente'` e `interrompe: [...]`) sem mudar API nem banco.
- **Parar o loop do modelo por condição já existia**, e o turno já aceitava receber o agente resolvido. A reexecução usa os dois.
- **O registro de decisões comporta a passagem sem mudança de banco** (ver o desvio 1).

### 11.2 Os três desvios deste desenho

1. **Sem mudança de banco.** A passagem pelo agente é gravada em `ai_router_decisions` com `outcome = 'reclassified'` e `confidence` nulo. O roteador sempre grava um número; o nulo é o que identifica a passagem. Um desfecho próprio pediria migration. Consequência: o motivo que o agente informa não fica gravado nessa tabela (ela não guarda texto), ao contrário do que a seção 3.1 dizia.
2. **Conversa simulada só na rota de teste, não na tela.** `POST /api/v1/ai/routers/:id/test` aceita `history` (até 6 mensagens) e `current_intent`, e responde `mode`, `kept_current` e `classified`. A bateria roda pela rota. O campo na tela fica para depois.
3. **Conversa recente no classificador só com o modo novo ligado.** A seção 3.3 valia para todo roteador. Como foi construído, roteador sem `permanencia: 'agente'` mantém o prompt do classificador byte a byte, e nenhum texto de mensagem anterior vai ao provedor sem alguém ligar o modo.

### 11.3 O que as revisões acrescentaram

- **O histórico leva a fala, não o enquadramento de mídia.** Cada mensagem entra com o texto digitado (ou a legenda) e a transcrição já pronta. A instrução que o agente recebe junto de uma mídia não entra: ela comia o corte de 300 caracteres e a transcrição sumia. Depois do bloco de histórico vai uma linha fixa dizendo que aquela conversa é dado, não instrução.
- **Atalho sem classificador.** Com a conversa em andamento, se nenhum assunto de `interrompe` é assunto do roteador e diferente do atual, nada que o classificador diga trocaria o agente. Nesse caso o classificador não é chamado, e nem os fatos nem a conversa são lidos. A rota de teste diz isso com `classified: false`.
- **O modo novo força a permanência no agente.** Com `permanencia: 'agente'`, o `sticky` do roteador vale como ligado mesmo que a configuração diga o contrário. Sem isso o modo não teria o que segurar.
- **Assunto atual sem registro.** Conversa com agente atual e sem assunto gravado usa o assunto do próprio membro. Senão o classificador repetir esse assunto contaria como troca.
- **A passagem é recusada, e o agente de origem responde,** quando o destino não tem versão publicada, está pausado, está fora do horário de funcionamento dele ou em modo assistido. Em todos esses casos passar deixaria a pessoa sem resposta agora.
- **Passagem junto com handoff humano no mesmo passo:** sai só o aviso de escalação. O agente de destino não responde por cima de uma conversa que foi para a equipe.
- **Passagem depois de já ter enviado no mesmo turno:** a passagem vale, mas não há reexecução. O dono novo assume na mensagem seguinte.
- **Retry de um job que já passou e já enviou não roda o modelo de novo.**
- **Onde a ação existe.** Só em turno de mensagem recebida, fora de prévia e de modo assistido, com roteador em modo novo, agente membro dele e ao menos um outro assunto. A reexecução nunca oferece a ação: é o que garante uma passagem por mensagem.

### 11.4 Limites conhecidos, que ficam

- **A passagem é gravada antes de o destino provar que roda.** Destino quebrado (sem credencial, modelo fora do ar) faz o job tentar com o destino até esgotar as tentativas. O passo seguinte seria desfazer a passagem quando a reexecução falha.
- **Um turno com passagem custa dois turnos.** São duas execuções completas de agente.
- **A mensagem em que há passagem pode levar o dobro do tempo** para ser respondida.
- **Assunto que interrompe chegando durante o turno da passagem.** Mensagem de assunto marcado em `interrompe` (queixa clínica) que chega DURANTE o turno em que há passagem é respondida pelo agente de destino, sem passar pelo roteador.
- **Resposta do destino em várias bolhas.** Se ela falha depois da primeira bolha, o retry não completa as que faltaram.
- **Pendência de caso aberto pela origem.** O destino só a enxerga se também tiver casos habilitados. É configuração do agente.
- **A decisão ainda não aparece em tela.** Continua valendo a seção 9: as decisões ficam em `ai_router_decisions` e falta mostrá-las por conversa.

### 11.5 O que não foi medido

Nada disso foi provado em conversa real nem pela tela. As provas são testes de unidade e invariantes em Postgres real com modelo simulado. Os critérios de sucesso da seção 2 seguem abertos até a versão ser instalada e a seção 5 (configuração) ser feita.
