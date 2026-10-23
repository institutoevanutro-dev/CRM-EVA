# Campanhas, contatos e vendas da clínica

A tela **Análise › Meta Ads** continua mostrando gasto e métricas da Meta. O botão **Ver contatos e vendas por campanha** acrescenta contatos captados no mesmo período e vendas registradas no Financeiro. O painel Marketing da Vercel ganha a aba **CRM e vendas** e consulta os mesmos agregados no CRM. As consultas são sob demanda e de leitura.

## Critério de atribuição

O webhook do WhatsApp preserva o `referral.source_id` no `source_metadata.ad_raw` do contato. Esse ID identifica o anúncio e é relacionado ao `campaign_id` pela API da Meta na conta escolhida. Um `utm_campaign_id` numérico também é aceito quando a origem UTM é Meta/Facebook/Instagram **e** a campanha pertence aos anúncios daquela conta. Título, nome da campanha e `ctwa_clid` não são usados como chave de campanha. Contato anonimizado fica fora do relatório. O período dos contatos usa o fuso da conta Meta.

Vendas são as vendas ativas do Financeiro, feitas no intervalo escolhido para contatos criados nesse intervalo e já vinculados a pacientes. `valor_cents` soma o preço dessas vendas; `recebido_cents` é o total líquido recebido **até a consulta**, inclusive pagamentos/estornos posteriores ao intervalo. O relatório mostra quantos contatos atribuídos foram vinculados; se houver contatos sem vínculo, os valores de vendas são parciais. Sem Financeiro disponível, vendas e valores ficam ausentes, jamais zero presumido. Limite de 90 dias e 5.000 contatos por consulta. O gasto pode estar na moeda da conta Meta; os valores financeiros estão em BRL. Não calcular ROI entre moedas diferentes.

## Configuração

No CRM, além da conexão de leitura Meta Ads e da conexão Financeiro já descrita no guia anterior:

- `MARKETING_ORGANIZATION_ID`: UUID fixo da organização autorizada.
- `MARKETING_REPORT_TOKEN`: segredo aleatório com pelo menos 32 caracteres, exclusivo do relatório agregado.

No servidor Vercel do painel Marketing:

- `CRM_REPORT_URL`: origem HTTPS do CRM, sem caminho, por exemplo `https://crm.exemplo.com.br`.
- `CRM_REPORT_TOKEN`: o mesmo valor de `MARKETING_REPORT_TOKEN`.

O navegador só fala com `/api/crm` do painel, protegido pela sessão existente. A função Vercel envia o segredo no cabeçalho ao CRM. O CRM restringe a consulta à organização configurada e devolve somente totais por campanha, sem contato individual, telefone, CPF ou prontuário. Limite de 60 pedidos por minuto por instância. Não colocar segredo no HTML, em `NEXT_PUBLIC_`, no repositório ou no chat.

## Ativação e verificação

1. Publicar a migration `0036_vendas_por_contatos_crm.sql` junto com o Financeiro e as duas novas rotas de integração.
2. Publicar o CRM com as variáveis da organização e de acesso ao Financeiro/Meta já previstas, além do segredo de Marketing.
3. Configurar o painel Vercel com origem e segredo do CRM e publicar a cópia do painel.
4. Com um anúncio de teste cujo `source_id` tenha sido capturado, confirmar o ID da campanha, o contato e a venda vinculada. Verificar também um contato orgânico, um paciente não vinculado, um pagamento estornado e uma conta Meta em outra moeda.

Há logins independentes entre aplicações. Não há envio automático de conversão financeira à Meta por este relatório; a rotina de conversão existente no CRM usa o estado do negócio no próprio CRM e deve ser tratada separadamente para evitar dupla contagem.

## Funil por origem (`/api/v1/integrations/marketing/funil-por-origem`)

Mesma credencial (`x-integracao-token`), organização, limite e janela de 90 dias. Devolve, por origem (`meta`, `google`,
`indicacao`, `organico`, sempre as quatro), quantos leads, agendamentos, sinais pagos e ganhos houve no período, a receita
dos ganhos (`receita_cents`, texto de dígitos) e quantos ganhos vieram sem valor. Regras em
`lib/integrations/marketing/funil-por-origem.ts`; o painel de anúncios calcula custo por agendamento, por sinal e retorno.

- **Origem é do contato:** anúncio da Meta ou do Google (`source_metadata.ad_platform`, primeiro toque); senão "Indicação"
  como etiqueta ou origem de algum lead do contato; senão orgânico. Google não é capturado hoje (o site não guarda o `gclid`).
- **Data do evento:** leads por `created_at` (sem a importação marcada `importacao_planilha`); agendamentos pelo
  `created_at` do primeiro da cadeia de remarcação, sem a agenda importada e sem o lançado por engano; sinais pela entrada
  numa etapa marcada como sinal pago em Configurações › Conversões; ganhos e receita por `closed_at`.
- **Limite:** planilha importada com coluna "origem" própria não deixa marca no lead e conta como lead do dia da importação.
