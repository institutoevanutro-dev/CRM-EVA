# Vários agentes e roteador com fatos do contato: desenho

Data: 11/10/2026. Decisões do André nesta conversa: divisão por assunto (opção A), roteador olha a agenda (opção A), troca de agente só com sinal claro (opção A), quinto agente de recepção geral (opção A).

## 1. Problema

A Cintia atende tudo com um prompt só, que chegou ao teto de 20.000 caracteres. Nos testes de 10 e 11/10 ela:

- pulou o roteiro do Dr. André (valor e sinal) com uma paciente que já tinha cadastro;
- falou de teleconsulta e de disponibilidade sem ninguém perguntar;
- ofereceu a unidade Serra para um profissional que só atende em Vitória;
- abriu caso para "confirmar com a equipe" um horário que a agenda mostrava livre.

Cada correção no prompt único empurra outra regra para fora ou cria conflito com uma regra vizinha.

## 2. Objetivo

Cada tipo de atendimento tem um agente com um roteiro só, e o roteador entrega a conversa ao agente certo. Sucesso, medido em conversa real com número de teste:

1. Consulta nova com o Dr. André segue o roteiro inteiro: objetivo, apresentação, valor, sinal, e só então unidade e horário.
2. Quem já é paciente dele não passa pela abertura nem pela apresentação de paciente novo; na consulta de acompanhamento o sinal é pedido antes do horário.
3. Massoterapia e procedimentos oferecem só a unidade em que o profissional atende, e o horário aceito fica gravado na agenda.
4. Queixa clínica sai do agente em que estiver e vai para o acolhimento com encaminhamento à Isadora.
5. O paciente continua falando com "a Cintia". A divisão é interna.

## 3. Os cinco agentes

Todos se apresentam como Cintia, usam o mesmo tom (mensagens curtas, sem travessão, terminando em pergunta) e as mesmas regras de limite clínico e privacidade. Todos rodam em GPT-5.4 no início; trocar modelo de algum deles é decisão posterior, com teste.

| Agente | Atende | Não faz | Ferramentas principais |
|---|---|---|---|
| 1. Consulta nova Dr. André | Quem pede consulta com o Dr. André e nunca consultou com ele. Roteiro de 9 passos já aprovado (abertura, acompanhamento atual, apresentação, R$490 ou R$650, sinal de R$100 ou integral, comprovante, unidade, horário, dados). | Não consulta agenda antes do sinal. Não trata retorno. | Agenda (consultar e marcar), Casos (comprovante de sinal, exceção de pagamento). |
| 2. Paciente do Dr. André | Quem já consultou com ele: retorno, consulta de acompanhamento, remarcação, cancelamento, dúvida administrativa sobre a consulta. A consulta de acompanhamento custa R$650 e tem sinal de R$100 (crédito no valor) ou pagamento integral, pedido antes de unidade e horário, como no agente 1. Retorno presencial e retorno por teleconsulta não têm sinal: vão direto para o horário (decisões do André em 11/10). | Não apresenta o protocolo de novo nem refaz a abertura de paciente novo. | Agenda (consultar, marcar, remarcar), Casos (comprovante de sinal). |
| 3. Massoterapia e procedimentos | Leonardo (drenagem, relaxante, mix, pós-operatório), aplicações, implante, EZBody e demais procedimentos da agenda. Valor, duração e horário. Por enquanto todos atendem só na unidade de Vitória (decisão do André em 11/10): o agente informa a unidade em vez de perguntar. | Não oferece a Serra. Não pede nome e CPF que já estão no cadastro. | Agenda (consultar e marcar). |
| 4. Queixa clínica | Dor, sintoma, reação após procedimento, dúvida sobre medicação ou exame. Acolhe em uma mensagem, abre caso para a Isadora com o resumo e informa o contato direto quando previsto. | Não orienta, não interpreta, não marca nada. | Casos, transferência para pessoa. |
| 5. Recepção geral | Endereço, horário, convênio, demais profissionais (Dra. Ana, nutrição, fisioterapia), e tudo que o roteador não classificar com segurança. | Não conduz roteiro do Dr. André nem massoterapia: quando o assunto fica claro, a próxima mensagem já vai para o agente certo. | Agenda (consultar e marcar para os demais profissionais), Casos, transferência. |

Os prompts saem do prompt atual da Cintia (versão 19), recortado por assunto. O que é comum (identidade, tom, limites clínicos, privacidade, "antes de responder") fica num bloco igual nos cinco. No plano de implementação confiro se esse bloco pode morar na Memória da organização em vez de ser copiado cinco vezes.

Cada agente mantém uma regra curta de segurança: se aparecer queixa clínica, abre caso para a Isadora na mesma resposta. Assim o encaminhamento clínico não depende só do roteador.

## 4. O roteador

Hoje o canal "Consultório Dr André" não tem roteador; o que existe está em outro número e vazio. Será criado um roteador para esse canal com cinco assuntos, um por agente, cada um com descrição e exemplos de mensagens reais.

Comportamento, que o CRM já tem:

- Primeira mensagem da conversa: o roteador classifica. Se a certeza ficar abaixo do limite (0,6 por padrão), vai para o agente 5.
- Mensagens seguintes: a conversa fica com o mesmo agente. O roteador reavalia cada mensagem e só troca quando classifica outro assunto com certeza acima do limite. Respostas curtas ("sim", "17h", "pode ser") não trocam.
- Se o classificador falhar, a conversa fica com o agente atual; se não houver agente atual, vai para o agente 5.

O limite de certeza começa em 0,6 e é ajustado pela bateria de teste da seção 6.

## 5. Mudança de código: fatos do contato no roteador

Hoje o classificador recebe só o texto da mensagem. "Quero agendar consulta com o Dr. André" não diz se a pessoa é nova ou paciente.

Mudança: junto com a mensagem, o classificador recebe um resumo curto lido do CRM no momento do turno:

- até 5 atendimentos concluídos mais recentes do contato: tipo do atendimento, nome do profissional responsável, data;
- compromissos futuros do contato: tipo, profissional, data;
- quando não houver nenhum: "sem atendimentos registrados".

As descrições dos assuntos passam a usar esses fatos: "para quem não tem atendimento concluído com o Dr. André" e "para quem já tem".

Regras da mudança:

- Só sai tipo, profissional e data. Nada de CPF, telefone, notas ou conteúdo clínico. O provedor do modelo já recebe a conversa inteira; esse resumo não acrescenta dado mais sensível.
- Leitura filtrada pela organização e pelo contato, sem depender de dados do corpo da requisição.
- Se a leitura falhar, o classificador roda só com a mensagem, como hoje, e o registro do turno anota que rodou sem fatos.
- A tela de teste do roteador ganha a opção de escolher um contato, para a bateria exercitar os fatos.
- Vale para qualquer organização: o resumo é genérico, quem dá sentido a ele é a descrição de cada assunto.
- Sem mudança de banco. Entra com testes, fragmento de versão e mapa de arquitetura, pelo fluxo normal (PR, revisão, versão nova).

Limites conhecidos:

- Paciente cuja última consulta seja anterior ao que está na agenda do CRM (conferido de julho de 2026 em diante) aparece como novo e cai no agente 1. O agente 1 terá uma saída: se a pessoa disser que já é paciente, ele responde que vai seguir pelo retorno e a mensagem seguinte é reclassificada.
- Os registros antigos não trazem o nome do profissional no título; a identificação é pelo responsável do compromisso. No plano confiro se isso separa bem o Dr. André dos demais.
- A decisão continua sendo de um modelo. Se a bateria mostrar erro na separação novo/paciente, o passo seguinte é uma regra fixa por assunto (condição exata conferida pelo sistema), que fica fora deste desenho.

## 6. Bateria de teste do roteador

Antes de ligar para qualquer paciente, uma lista de cerca de 40 mensagens com o agente esperado, rodada na tela de teste do roteador:

- pedidos claros de cada assunto;
- a mesma frase ambígua com contato novo e com contato que já consultou;
- respostas curtas no meio de uma marcação (não podem trocar de agente);
- troca de assunto explícita no meio da conversa;
- queixa clínica dita de formas diferentes, inclusive junto com pedido de agendamento;
- mensagens fora de assunto (devem ir para o agente 5).

Critério para seguir: nenhuma queixa clínica classificada fora do agente 4 e nenhuma consulta nova do Dr. André fora do agente 1. Os demais erros são corrigidos em descrição e exemplos e a bateria roda de novo.

## 7. Ordem de entrega

1. Código dos fatos do contato no roteador, com a tela de teste. PR, revisão, versão nova instalada na clínica.
2. Cinco agentes em rascunho, cada um testado com mensagem única.
3. Roteador do canal criado e inativo, com os cinco assuntos.
4. Bateria de teste. Ajustes até passar no critério.
5. Publicação dos agentes e ativação do roteador com o canal ainda restrito à lista de números de teste. Teste em conversa real, com conversa zerada, de cada um dos cinco caminhos.
6. Liberação para todos os pacientes, com o seu OK.

Até o passo 5, a Cintia única (versão 19) continua atendendo.

## 8. Como voltar atrás

Desativar o roteador do canal. A conversa volta a ser atendida pelo agente publicado do canal, que continua sendo a Cintia única. Os cinco agentes ficam publicados sem receber conversa. Nenhum dado de paciente é alterado pela mudança.

## 9. Riscos

- **Classificação errada na primeira mensagem.** Mitigação: bateria, agente 5 como destino da dúvida, e a regra clínica presente em todos os agentes.
- **Cinco prompts para manter.** Mitigação: bloco comum único; mudanças de tom ou de limite clínico são feitas uma vez e replicadas.
- **Publicação com configuração incompleta**, como na versão 18. Mitigação: toda publicação confere ferramentas, Casos, balões e follow-up antes e depois, e o defeito da edição de rascunho está sendo corrigido em tarefa separada.
- **Custo.** Cada mensagem passa a ter uma chamada a mais, do classificador, num modelo barato. O prompt de cada agente fica menor que o atual, o que reduz o custo da chamada principal.
- **Crédito do provedor esgotado**, como em 11/10. Fora deste desenho, mas vale um aviso de saldo baixo.

## 10. Fora deste desenho

- Agentes Confirmação, Isadora e Erick (existem só como cadastro).
- Regra fixa por assunto no roteador.
- Anti-resfriamento com fotos, pagamento integrado, trava de dono, passos por card.
- Roteador do outro número de WhatsApp.

## 11. Pontos a confirmar no plano

- Se o bloco comum cabe na Memória da organização.
- Se o responsável do compromisso identifica bem o Dr. André nos registros antigos.
