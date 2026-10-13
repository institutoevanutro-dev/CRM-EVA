---
impacto: capacidade_nova
secao: adicionado
titulo: Pacientes pelo cadastro, para quem já tem cadastro entrar pelo funil de clientes sem depender da agenda
---
Em Configurações › Tipos de agendamento, logo abaixo de "Clientes pela agenda", há uma segunda opção: **Pacientes pelo cadastro**. Ela nasce desligada, e nada muda até um administrador ligá-la. Ligada, o contato que já tem cadastro de paciente (está ligado a um paciente do prontuário, ou tem CPF guardado) é tratado como cliente quando escreve: o card dele nasce no funil marcado como funil de clientes, e não no de entrada, mesmo que ele nunca tenha tido horário marcado no CRM. Quem não tem cadastro continua entrando pelo funil padrão. Contato anonimizado ou juntado a outro fica de fora, e contato bloqueado continua sem card.

Ao ligar, a tela primeiro conta e mostra quantos contatos têm cadastro, e só grava depois da confirmação. Nenhum contato é alterado: a opção não põe a etiqueta "cliente" em ninguém e não mexe em "Cliente desde", que continuam sendo só da regra da agenda. Por isso desligar não tem o que desfazer. Os cards que já existem não mudam de funil; a regra vale para os cards que nascem depois. Na lista de contatos, quem entra por essa regra aparece com o selo "Cliente", e a ficha diz "Pelo cadastro de paciente". A tela de Funis passa a oferecer "Funil de clientes" também quando só esta opção está ligada; sem um funil marcado, todos seguem entrando pelo funil padrão, e a tela avisa.

O que a opção não resolve: paciente que escreve de um número que não está no cadastro chega como contato novo e entra pelo funil padrão. Ligar e desligar ficam na auditoria (`crm.paciente_pelo_cadastro_alterado`). A atualização aplica a migration 0360 sozinha; nada a fazer na VPS.
