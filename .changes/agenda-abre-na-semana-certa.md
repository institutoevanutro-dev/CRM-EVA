---
impacto: nada_mudou
secao: corrigido
titulo: A Agenda abre na semana certa, no fuso da empresa
---

Quem abrisse a Agenda no fim da noite de sábado via, por um instante, a semana
seguinte — com os compromissos da semana seguinte — e só então a tela se
corrigia sozinha. Acontecia porque o servidor calculava a semana pelo relógio
dele, em UTC, enquanto a tela usava o fuso de quem estava olhando.

Agora a semana vem do fuso cadastrado em **Configurações › Empresa**, nos dois
lados: servidor e tela abrem a mesma semana, e o botão "Hoje" também. Vale
igual para quem acessa de outro estado ou país. Se o fuso gravado for
inválido, a Agenda abre no padrão em vez de falhar.

Correção portada do projeto original (DeskcommCRM, issue #1350).
