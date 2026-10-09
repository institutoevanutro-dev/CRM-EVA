# Integração opcional com o PrecificaEva (catálogo de preços)

## O que muda
O PrecificaEva é a fonte única de preço da clínica. Com a integração ligada, o cron `GET /api/v1/cron/precificaeva-catalogo` (de hora em hora, minuto 17) lê a função `tabela-precos` do PrecificaEva, a mesma que o financeiro lê, e atualiza **Produtos** (`catalog_products`):

- cada serviço com preço comercial vira um item (código `pe:proc:<id>`), com a área do PrecificaEva como categoria;
- medicações NÃO entram: o catálogo é o que o agente de IA usa para responder pacientes, e preço de medicação não é informado por ele (decisão do dono da clínica, 08/10/2026);
- item da planilha com o **mesmo nome** de um item do PrecificaEva é ligado a ele (mantém o id, que a agenda usa) em vez de duplicado;
- item ligado que some do PrecificaEva ou perde o preço é desativado; item que só existe no CRM fica como está;
- itens ligados têm `origem = 'precificaeva'` e `controla_estoque = false` (serviço não tem estoque).

Nome, categoria, preço, custo e situação dos itens ligados são sobrescritos a cada rodada. A tela de Produtos avisa isso e não deixa editar preço e custo desses itens; duração e demais campos continuam editáveis no CRM.

## Configuração no servidor
Variáveis opcionais (`env_file: .env`); as três vazias = rodada pulada com 200:
- `PRECIFICAEVA_URL`: endereço completo da função, https (ex.: `https://<projeto>.supabase.co/functions/v1/tabela-precos`).
- `PRECIFICAEVA_TOKEN`: o `INTEGRACAO_TOKEN` do PrecificaEva (32+ caracteres). Vai no cabeçalho `x-integracao-token`, nunca na URL.
- `PRECIFICAEVA_ORGANIZATION_ID`: UUID da organização que recebe o catálogo.

Ligada pela metade responde 503 (o operador precisa ver). Erro remoto responde 503 sem detalhe.

## Verificação
1. Configurar as três variáveis e esperar a rodada (ou chamar o cron com o segredo interno).
2. Em Produtos, conferir os itens com "preço do PrecificaEva" e os preços iguais aos do PrecificaEva.
3. Mudar um preço no PrecificaEva e conferir no CRM na rodada seguinte.

Sem migration. Auditoria: uma linha `catalog_product.synced` por rodada com efeito (contagens no metadata).

## Living System Checklist
Entrada: função `tabela-precos` do PrecificaEva. Saída: `catalog_products`, que o agente de IA e a agenda leem. Registro: `catalog_product.synced` só quando algo muda. Porta: Produtos (selo "preço do PrecificaEva" e aviso na edição). Falha: 503 no log do scheduler; o catálogo fica com os últimos preços. Configuração ausente: rodada pulada.
