---
impacto: capacidade_nova
secao: adicionado
titulo: Avisar a Meta e o Google Ads quando um paciente agenda e quando paga o sinal (vem desligado)
---

Em Configurações › Conversões dá para ligar, por plataforma e cada um à parte,
dois avisos: que um paciente agendou e que o sinal foi pago. O sinal pago é a
entrada do negócio numa etapa do funil que quem administra marca na mesma tela
(nenhuma vem marcada). Na Meta ele vai como `CompleteRegistration`, sem valor;
no Google, para uma ação de conversão própria. Sai só isso: que o evento
aconteceu, a hora, um código que não se reverte e o telefone (e o e-mail, se
houver) embaralhado com SHA-256. Nome, procedimento, tipo de consulta,
profissional, observação, etapa e valor nunca saem. Vem desligado; a opção "só
pacientes que vieram de anúncio" vem ligada. Quem tinha o envio de vendas
ligado encontra a conexão desligada depois da atualização: o envio de vendas
saiu, e mandar estes avisos é uma decisão nova. Contato bloqueado, marcado como
sempre atendimento humano, oculto ou anonimizado nunca sai. Cada aviso sai uma
vez só; cancelar ou tirar da etapa depois não manda nada. Se o envio parar de
sair, abre um aviso na Central.
