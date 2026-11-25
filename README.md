# nAIls — SaaS de agendamento para nail designers e salões de beleza

Assinatura mensal para salões: cada salão cria sua conta, ganha uma página de agendamento própria
(`/s/nome-do-salao`) e um painel completo, com um agente automático de lembretes e confirmações.

**Sem dependências**: só precisa do Node.js 22.13+ (usa o SQLite embutido no Node; Stripe e WhatsApp via `fetch`).

## Rodar

```bash
npm install
npm start
```

Chaves e configurações ficam no arquivo `.env` (copie de `.env.example`; ele não vai para o GitHub).

| Endereço | O que é |
|---|---|
| http://localhost:3000 | Landing page do nAIls (recursos, agentes, planos) |
| http://localhost:3000/cadastro | Criar conta de salão (14 dias grátis, sem cartão) |
| http://localhost:3000/entrar | Login do painel |
| http://localhost:3000/painel | Painel do salão |
| http://localhost:3000/s/&lt;slug&gt; | Página de agendamento de cada salão |

### Variáveis de ambiente

| Variável | Para quê |
|---|---|
| `PORT` | Porta (padrão 3000) |
| `DATA_DIR` | Pasta dos bancos (padrão `data/`) |
| `STRIPE_SECRET_KEY` | Chave do Stripe (`sk_test_...` para testes). **Sem ela, a cobrança roda em modo demonstração**: assinar só ativa o plano, sem cobrar. Em produção (`NODE_ENV=production`) o servidor não sobe sem ela. |
| `STRIPE_WEBHOOK_SECRET` | Segredo do webhook (`whsec_...`), para receber os eventos em `/api/billing/webhook` |

## Assinatura e planos

| Plano | Preço | Profissionais ativas |
|---|---|---|
| Essencial | R$ 49/mês | 1 |
| Profissional | R$ 99/mês | até 5, com o agente de lembretes |
| Studio | R$ 179/mês | ilimitadas, com todos os agentes |

Preços e recursos ficam em `billing.js` (`PLANS`); a landing page e o painel leem de lá.

- **Teste grátis** de 14 dias com os limites do plano escolhido no cadastro (padrão: Profissional).
- **Sem assinatura** (teste encerrado ou cancelada): a página do salão continua no ar, mas **não aceita agendamentos**, e o painel mostra o aviso para assinar.
- **Pagamento pendente**: a agenda segue funcionando enquanto o Stripe tenta cobrar de novo.
- O limite de profissionais é conferido ao cadastrar ou reativar uma profissional.

### Stripe

1. Crie uma conta no Stripe e copie a chave secreta de teste (`sk_test_...`).
2. Rode com `STRIPE_SECRET_KEY=sk_test_... npm start`.
3. Os preços são criados no Stripe sozinhos na primeira assinatura de cada plano (`lookup_key` `nails_<plano>`).
   Mudar o valor em `PLANS` cria um preço novo automaticamente.
4. Webhook: aponte para `https://seu-dominio/api/billing/webhook` com os eventos
   `checkout.session.completed`, `customer.subscription.created/updated/deleted` e `invoice.payment_failed`,
   e configure `STRIPE_WEBHOOK_SECRET`. Para testar no computador:
   `stripe listen --forward-to localhost:3000/api/billing/webhook`.
   Mesmo sem webhook, ao voltar do checkout o painel confirma o pagamento direto no Stripe.
5. Cartão de teste: `4242 4242 4242 4242`, qualquer data futura e CVC.
6. Ative o **portal do cliente** no Stripe (Configurações → Billing → Customer portal): é por ele que o salão troca o cartão, vê faturas e cancela.

## Como os dados são separados

```
data/nails.db          plataforma: salões, contas, sessões e assinaturas
data/saloes/<id>.db    um banco por salão: serviços, profissionais, agenda, fila de espera
```

Cada requisição roda "dentro" de um salão (`runAsSalon` em `db.js`, com `AsyncLocalStorage`), e `db` aponta
para o banco daquele salão. Assim um salão nunca enxerga dados de outro, e o código da agenda não precisa
repetir o filtro de salão em cada consulta.

Senhas com scrypt; sessões de 30 dias guardadas só como hash do token; limite de tentativas de login e de cadastros por IP.

## Funcionalidades da agenda (por salão)

- Serviços com preço e duração; agendamento em 5 passos (serviço → profissional → dia → horário → dados)
- Só aparecem horários livres (expediente, almoço, folgas e outras clientes)
- **Fila de espera**: horário ocupado → a cliente entra na fila; se vagar, a primeira da fila ganha o horário automaticamente
- Consulta e cancelamento pelo código + telefone, com motivo e mensagem pronta para o WhatsApp
- Painel: agenda por profissional, faturamento previsto/realizado, status, agendamento manual,
  fila de espera, serviços, profissionais e expediente, folgas e bloqueios, dados do salão, assinatura

## Estrutura

```
server.js        API REST, rotas por salão (/api/s/<slug>/...), contas e servidor de arquivos
db.js            Banco da plataforma, banco por salão e contexto do salão atual
billing.js       Planos, situação da assinatura e integração com o Stripe
agents/
  lembretes.js   Agente de lembretes: agenda dos envios, link de confirmação, respostas, painel
  whatsapp.js    API do WhatsApp Business (Meta): modelos, texto, webhook
public/
  landing.html   Página de vendas do nAIls        landing.css
  cadastro.html  Criar conta                       entrar.html   Login
  index.html     Página de agendamento do salão    app.js
  confirmar.html Link da cliente para confirmar ou desmarcar (/c/<código>)
  admin.html     Painel do salão                   admin.js
  common.js      Funções compartilhadas            style.css     Tema preto e roxo nAIls
```

## Agente de lembretes e confirmações

Incluído nos planos **Profissional** e **Studio**. Ligado por padrão; cada salão ajusta na aba **Agentes** do painel.

- **Na véspera**, a partir do horário escolhido pelo salão (padrão 18:00, nunca depois das 21:30), lembra cada cliente de amanhã
  e pede confirmação. Quem agendou depois desse horário não recebe (acabou de marcar).
- **2 horas antes**, um aviso curto (não vai para quem agendou há menos de 3 horas nem para horário desmarcado).
- Cada mensagem tem um **link pessoal** (`/c/<código>`) onde a cliente **confirma** ou **desmarca** (com motivo opcional), sem login.
  Desmarcar segue o mesmo caminho do cancelamento pelo site: o horário vai para a **fila de espera** e o painel avisa.
- Na agenda do painel, cada horário mostra **✓ confirmou** ou **aguardando confirmação**.

### Dois canais

| | Sem a API da Meta (padrão) | Com a API da Meta (WhatsApp Business) |
|---|---|---|
| Envio | O agente prepara as mensagens e elas aparecem em **Agentes → Para enviar**; a dona toca em "Enviar no WhatsApp" | Automático, pelo número do nAIls, com modelos aprovados pela Meta |
| Respostas da cliente | Chegam no WhatsApp do salão | O agente entende a resposta por palavras-chave e age: **confirma**, **desmarca**, manda o **link para remarcar** ou registra a **pergunta** para o salão |
| Falha no envio | — | O lembrete cai na lista "Para enviar" do painel |
| Vaga da fila de espera | Aviso no painel com botão do WhatsApp (já existia) | Avisa a cliente sozinho (modelo `vaga`, opcional) |


### Configurar o WhatsApp automático (Meta)

1. Crie um app no [Meta for Developers](https://developers.facebook.com) com o produto **WhatsApp**, verifique a empresa e cadastre o número que vai enviar.
2. Crie e envie para aprovação os modelos (categoria **Utilidade**, idioma Português BR). Todos usam as mesmas 5 variáveis:
   `{{1}}` nome da cliente, `{{2}}` salão, `{{3}}` serviço, `{{4}}` quando, `{{5}}` link. Sugestões de texto:
   - `nails_lembrete_vespera`: *Oi, {{1}}! Passando para lembrar do seu horário de {{3}} {{4}}, no {{2}}. Confirme ou desmarque por aqui: {{5}}*
   - `nails_aviso_2h`: *Oi, {{1}}! Seu horário de {{3}} é {{4}}. Te esperamos no {{2}}! Se não puder vir, avise aqui: {{5}}*
   - `nails_vaga` (opcional): *Oi, {{1}}! Vagou o horário de {{3}} {{4}} no {{2}} e ele é seu. Confirme ou desmarque: {{5}}*
3. Configure as variáveis e reinicie o servidor:

| Variável | Valor |
|---|---|
| `WHATSAPP_TOKEN` | Token permanente (usuário do sistema) |
| `WHATSAPP_PHONE_NUMBER_ID` | ID do número |
| `WHATSAPP_TEMPLATE_VESPERA` / `WHATSAPP_TEMPLATE_2H` / `WHATSAPP_TEMPLATE_VAGA` | Nomes dos modelos aprovados |
| `WHATSAPP_TEMPLATE_LANG` | Idioma dos modelos (padrão `pt_BR`) |
| `WHATSAPP_APP_SECRET` | Segredo do app (confere que as respostas vêm mesmo da Meta) |
| `WHATSAPP_VERIFY_TOKEN` | Texto que você escolhe para a Meta validar o webhook |

4. No app da Meta, aponte o webhook para `https://seu-dominio/api/whatsapp/webhook` com o mesmo `WHATSAPP_VERIFY_TOKEN` e assine o campo **messages**.

A Meta cobra por conversa iniciada pelo modelo. As respostas do agente saem como texto livre, permitido nas 24h após a mensagem da cliente.

### Testar

`NAILS_TEST_CLOCK=1` permite chamar `POST /api/admin/agentes/rodar` com `{ "now": "<data ISO>" }` para simular a véspera
ou o dia, sem esperar o relógio (só para testes; desligado por padrão). `NAILS_SCHEDULER=off` desliga a verificação a cada minuto.

## Sem IA paga, por enquanto

O agente de lembretes funciona sem nenhum serviço pago: mensagens prontas (nome, serviço, horário e link)
e respostas entendidas por palavras-chave ("sim", "confirmo", "não vou", "remarcar"...).
Uma versão com o Claude escrevendo as mensagens e entendendo respostas livres foi retirada porque a API
cobra por uso; ela está no histórico do git (commit `114ed39`) para ser religada no futuro.

## Próximos agentes

- **Assistente da dona**: resumo do dia, faturamento, clientes que sumiram com mensagem de reativação, horários fracos
- **Conteúdo para Instagram**: legendas e ideias de posts, promoções relâmpago para horários vagos

Outros passos para produção: hospedagem com HTTPS, envio de e-mail (recuperar senha), backups da pasta `data/`.
