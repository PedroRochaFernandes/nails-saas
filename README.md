# nAIls — SaaS de agendamento com IA para nail designers e salões de beleza

Assinatura mensal para salões: cada salão cria sua conta, ganha uma página de agendamento própria
(`/s/nome-do-salao`) e um painel completo. Agentes de IA chegam na próxima fase.

**Sem dependências**: só precisa do Node.js 22.13+ (usa o SQLite embutido no Node e a API REST do Stripe via `fetch`).

## Rodar

```bash
npm start
```

| Endereço | O que é |
|---|---|
| http://localhost:3000 | Landing page do nAIls (recursos, agentes de IA, planos) |
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
| Profissional | R$ 99/mês | até 5 (e agentes de IA quando lançados) |
| Studio | R$ 179/mês | ilimitadas |

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
public/
  landing.html   Página de vendas do nAIls        landing.css
  cadastro.html  Criar conta                       entrar.html   Login
  index.html     Página de agendamento do salão    app.js
  admin.html     Painel do salão                   admin.js
  common.js      Funções compartilhadas            style.css     Tema preto e roxo nAIls
```

## Próxima fase: agentes de IA

- **Lembretes e confirmações**: lembrete na véspera, pedido de confirmação e oferta da vaga à fila de espera se a cliente desmarcar
- **Assistente da dona**: resumo do dia, faturamento, clientes que sumiram com mensagem de reativação, horários fracos
- **Conteúdo para Instagram**: legendas e ideias de posts, promoções relâmpago para horários vagos

Outros passos para produção: hospedagem com HTTPS, envio de e-mail (recuperar senha), backups da pasta `data/`.
