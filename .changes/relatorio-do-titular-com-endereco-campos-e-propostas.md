---
impacto: nada_mudou
secao: corrigido
titulo: O relatório de dados do paciente passa a trazer o endereço, os campos personalizados e o que a IA sugeriu para o cadastro
---

Quando um paciente pede "quais dados vocês têm de mim", a clínica gera um relatório (um PDF, com
um arquivo de dados guardado junto). Esse relatório deixava de fora duas coisas que o sistema
guarda:

- o endereço e os campos personalizados da ficha (convênio, como conheceu a clínica e o que mais
  a clínica tiver criado). O sistema lia esses campos e não colocava no relatório;
- as sugestões de cadastro feitas pela IA: quando ela percebe na conversa um nome, e-mail ou
  telefone diferente do cadastrado, ela propõe a troca e guarda o trecho da conversa.

Agora os dois aparecem no PDF e no arquivo de dados. Também passam a aparecer a descrição e os
campos de cada negócio do paciente, o texto das atividades (só no arquivo de dados) e os
cadastros antigos dele que foram juntados ao atual. Os campos saem com o nome que a clínica deu a
eles (por exemplo "Convênio: Unimed"), e não com o código interno.

Um cuidado com o CPF: se alguém digitou o CPF do paciente num campo personalizado ou numa
observação, o número **não** sai no relatório. A linha do CPF só diz "Informado em campo
personalizado (valor não exibido)", uma vez, do mesmo jeito que o CPF do cadastro já aparecia só
como "Armazenado (criptografado)". Isso vale para o PDF e para o arquivo de dados, e também para
os outros textos do relatório: o formulário de captação, o caso que a IA abriu, os pedidos, os
avisos e os comentários do Instagram. O CPF é reconhecido com ou sem pontos, espaços e hífens.
