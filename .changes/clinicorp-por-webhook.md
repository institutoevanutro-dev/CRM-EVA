---
impacto: capacidade_nova
secao: adicionado
titulo: A Clinicorp sem o módulo API Externa pode mandar a agenda por webhook (em teste)
---
Na seção **Agenda da Clinicorp** (Configurações › Agenda), o botão **Gerar endereço do webhook**
cria um endereço para cadastrar na Clinicorp, em Gerenciar Assinatura › Acesso Externo e
integrações › Gestão de Webhook. Serve a qualquer plano, inclusive a clínica que não tem o
módulo API Externa. O endereço aparece uma vez só, para copiar; gerar outro desliga o anterior.
Por enquanto o CRM só registra o formato do que a Clinicorp manda (nomes dos campos e tipos,
nenhum valor do paciente) e mostra na própria seção a última batida e os formatos recebidos.
A Agenda passa a descontar esses horários numa próxima versão, depois que o formato for
conferido. A parte do "Usuário API" e do "Token API" agora diz que só vale com o módulo
API Externa da Clinicorp.
