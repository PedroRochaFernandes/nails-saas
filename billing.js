// Planos de assinatura e cobrança pelo Stripe (API REST direta, sem SDK)
//
// Variáveis de ambiente:
//   STRIPE_SECRET_KEY      sk_test_... ou sk_live_...  (sem ela, a cobrança roda em MODO DEMONSTRAÇÃO)
//   STRIPE_WEBHOOK_SECRET  whsec_...                   (assinatura dos eventos enviados a /api/billing/webhook)
//
// Os preços são criados no Stripe automaticamente na primeira assinatura de cada plano,
// identificados pela lookup_key "nails_<plano>". Não é preciso cadastrar nada no painel do Stripe.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { platform } from './db.js';

export const TRIAL_DAYS = 14;

export const PLANS = {
  essencial: {
    name: 'Essencial', priceCents: 4900, maxPros: 1, agents: false,
    pitch: 'Para a nail designer que atende sozinha.',
    features: ['1 profissional', 'Página de agendamento própria', 'Fila de espera automática', 'Painel com agenda e faturamento'],
  },
  profissional: {
    name: 'Profissional', priceCents: 9900, maxPros: 5, agents: true, highlight: true,
    pitch: 'Para estúdios com equipe.',
    features: ['Até 5 profissionais', 'Tudo do Essencial', 'Agente de lembretes e confirmações com IA', 'Suporte prioritário'],
  },
  studio: {
    name: 'Studio', priceCents: 17900, maxPros: null, agents: true,
    pitch: 'Para salões de beleza maiores.',
    features: ['Profissionais ilimitadas', 'Tudo do Profissional', 'Todos os agentes de IA', 'Ajuda na configuração inicial'],
  },
};

const KEY = process.env.STRIPE_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

/** 'stripe' com chave configurada; 'demo' sem chave (simula a assinatura, nunca em produção). */
export const BILLING_MODE = KEY ? 'stripe' : 'demo';
if (BILLING_MODE === 'demo' && process.env.NODE_ENV === 'production') {
  throw new Error('STRIPE_SECRET_KEY é obrigatória em produção (sem ela, qualquer salão ativaria um plano de graça).');
}

export class BillingError extends Error {}

// ---------------------------------------------------------------- situação da assinatura
/**
 * O que o salão pode usar agora.
 *   online: a página de agendamento aceita clientes
 *   label:  texto curto para o painel
 */
export function salonAccess(s, now = new Date()) {
  const trialLeftMs = s.trial_ends_at ? new Date(s.trial_ends_at) - now : 0;
  const trialDaysLeft = Math.max(0, Math.ceil(trialLeftMs / 86_400_000));
  switch (s.status) {
    case 'active':   return { online: true, label: 'Ativa', trialDaysLeft: 0 };
    case 'past_due': return { online: true, label: 'Pagamento pendente', trialDaysLeft: 0 }; // o Stripe ainda tenta cobrar
    case 'trialing':
      return trialLeftMs > 0
        ? { online: true, label: 'Teste grátis', trialDaysLeft }
        : { online: false, label: 'Teste grátis encerrado', trialDaysLeft: 0 };
    case 'incomplete': return { online: false, label: 'Aguardando pagamento', trialDaysLeft: 0 };
    default:           return { online: false, label: 'Assinatura cancelada', trialDaysLeft: 0 };
  }
}

/** Limite de profissionais ativas. Durante o teste grátis vale o plano escolhido (padrão: Profissional). */
export const maxProsFor = salon => (PLANS[salon.plan] || PLANS.profissional).maxPros;

/** Os agentes de IA estão no plano do salão e a assinatura está em dia? */
export const agentsAllowed = salon => !!(PLANS[salon.plan] || PLANS.profissional).agents && salonAccess(salon).online;

// ---------------------------------------------------------------- API do Stripe
/** Converte { a: { b: 1 }, items: [{ x: 2 }] } em a[b]=1&items[0][x]=2 (formato da API do Stripe). */
function formEncode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function stripe(method, endpoint, params = {}) {
  const qs = formEncode(params);
  const url = `https://api.stripe.com/v1/${endpoint}${method === 'GET' && [...qs].length ? `?${qs}` : ''}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'GET' ? undefined : qs,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new BillingError(`Stripe: ${data.error?.message || res.status}`);
  return data;
}

const priceCache = new Map();
/** Preço mensal do plano no Stripe (cria produto e preço na primeira vez). */
async function priceFor(planKey) {
  if (priceCache.has(planKey)) return priceCache.get(planKey);
  const plan = PLANS[planKey];
  const lookup = `nails_${planKey}`;
  const found = await stripe('GET', 'prices', { lookup_keys: [lookup], active: true, limit: 1 });
  let price = found.data?.[0];
  // preço com outro valor (o plano mudou de preço no código): cria um novo e transfere a lookup_key
  if (!price || price.unit_amount !== plan.priceCents) {
    price = await stripe('POST', 'prices', {
      currency: 'brl', unit_amount: plan.priceCents, recurring: { interval: 'month' }, lookup_key: lookup,
      transfer_lookup_key: true, product_data: { name: `nAIls ${plan.name}` },
    });
  }
  priceCache.set(planKey, price.id);
  return price.id;
}

const planFromPrice = price => {
  const key = String(price?.lookup_key || '').replace(/^nails_/, '');
  return PLANS[key] ? key : null;
};

// ---------------------------------------------------------------- ações do painel
const updateSalon = (id, fields) => {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  platform.prepare(`UPDATE salons SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map(k => fields[k]), id);
};
const addDaysIso = n => new Date(Date.now() + n * 86_400_000).toISOString();

/**
 * Assinar ou trocar de plano. Devolve { url } para onde mandar o navegador,
 * ou { changed: true } quando a troca foi feita direto na assinatura existente.
 */
export async function startCheckout(salon, user, planKey, origin) {
  if (!PLANS[planKey]) throw new BillingError('Plano inválido');

  if (BILLING_MODE === 'demo') { // simula um pagamento aprovado
    updateSalon(salon.id, { plan: planKey, status: 'active', current_period_end: addDaysIso(30) });
    return { changed: true, demo: true };
  }

  // Já tem assinatura em andamento: troca o preço dela (o Stripe calcula a diferença proporcional)
  if (salon.stripe_subscription_id && ['active', 'past_due'].includes(salon.status)) {
    const sub = await stripe('GET', `subscriptions/${salon.stripe_subscription_id}`);
    await stripe('POST', `subscriptions/${sub.id}`, {
      items: [{ id: sub.items.data[0].id, price: await priceFor(planKey) }],
      proration_behavior: 'create_prorations',
      metadata: { salon_id: salon.id, plan: planKey },
    });
    updateSalon(salon.id, { plan: planKey });
    return { changed: true };
  }

  const session = await stripe('POST', 'checkout/sessions', {
    mode: 'subscription',
    locale: 'pt-BR',
    client_reference_id: salon.id,
    ...(salon.stripe_customer_id ? { customer: salon.stripe_customer_id } : { customer_email: user.email }),
    line_items: [{ price: await priceFor(planKey), quantity: 1 }],
    subscription_data: { metadata: { salon_id: salon.id, plan: planKey } },
    metadata: { salon_id: salon.id, plan: planKey },
    allow_promotion_codes: true,
    success_url: `${origin}/painel?checkout={CHECKOUT_SESSION_ID}#assinatura`,
    cancel_url: `${origin}/painel#assinatura`,
  });
  return { url: session.url };
}

/** Portal do Stripe: trocar cartão, ver faturas, cancelar. */
export async function billingPortal(salon, origin) {
  if (BILLING_MODE === 'demo') throw new BillingError('No modo demonstração não há portal de pagamento.');
  if (!salon.stripe_customer_id) throw new BillingError('Você ainda não tem uma assinatura paga.');
  const s = await stripe('POST', 'billing_portal/sessions', { customer: salon.stripe_customer_id, return_url: `${origin}/painel#assinatura` });
  return { url: s.url };
}

/** Cancelar no modo demonstração (no Stripe, o cancelamento é feito pelo portal). */
export function cancelDemo(salon) {
  if (BILLING_MODE !== 'demo') throw new BillingError('Cancele pelo portal de pagamento.');
  updateSalon(salon.id, { status: 'canceled' });
}

// ---------------------------------------------------------------- sincronização com o Stripe
const STATUS_MAP = { active: 'active', trialing: 'active', past_due: 'past_due', unpaid: 'canceled', canceled: 'canceled',
  incomplete: 'incomplete', incomplete_expired: 'canceled', paused: 'canceled' };

function applySubscription(salonId, sub) {
  const item = sub.items?.data?.[0];
  const periodEnd = sub.current_period_end ?? item?.current_period_end; // o campo mudou de lugar nas versões novas da API
  updateSalon(salonId, {
    stripe_subscription_id: sub.id,
    stripe_customer_id: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
    status: STATUS_MAP[sub.status] || 'canceled',
    ...(planFromPrice(item?.price) ? { plan: planFromPrice(item.price) } : {}),
    ...(periodEnd ? { current_period_end: new Date(periodEnd * 1000).toISOString() } : {}),
  });
}

function salonIdFor(obj) {
  const fromMeta = Number(obj.metadata?.salon_id || obj.client_reference_id);
  if (fromMeta) return fromMeta;
  const row = platform.prepare('SELECT id FROM salons WHERE stripe_subscription_id = ? OR stripe_customer_id = ?')
    .get(String(obj.id), String(obj.customer || ''));
  return row?.id ?? null;
}

/**
 * Volta do checkout: confirma o pagamento direto no Stripe, sem esperar o webhook
 * (útil em desenvolvimento, quando o webhook não chega até o computador).
 */
export async function syncCheckout(salon, sessionId) {
  if (BILLING_MODE === 'demo' || !/^cs_[\w]+$/.test(String(sessionId))) return;
  const s = await stripe('GET', `checkout/sessions/${sessionId}`, { expand: ['subscription'] });
  if (Number(s.client_reference_id) !== salon.id) throw new BillingError('Pagamento de outro salão.');
  if (s.subscription && typeof s.subscription === 'object') applySubscription(salon.id, s.subscription);
}

/** Confere a assinatura do evento (cabeçalho Stripe-Signature) com o segredo do webhook. */
export function verifyWebhook(raw, header, now = Date.now()) {
  if (!WEBHOOK_SECRET) throw new BillingError('STRIPE_WEBHOOK_SECRET não configurado');
  const parts = String(header || '').split(',').map(p => p.split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !sigs.length) throw new BillingError('Assinatura do webhook ausente');
  if (Math.abs(now / 1000 - t) > 300) throw new BillingError('Webhook expirado');
  const expected = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${raw}`).digest();
  const ok = sigs.some(s => {
    const got = Buffer.from(s, 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  if (!ok) throw new BillingError('Assinatura do webhook inválida');
  return JSON.parse(raw);
}

export async function handleWebhookEvent(event) {
  const obj = event.data?.object || {};
  switch (event.type) {
    case 'checkout.session.completed': {
      const salonId = salonIdFor(obj);
      if (!salonId) return;
      updateSalon(salonId, { stripe_customer_id: obj.customer, stripe_subscription_id: obj.subscription });
      if (obj.subscription && KEY) applySubscription(salonId, await stripe('GET', `subscriptions/${obj.subscription}`));
      return;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const salonId = salonIdFor(obj);
      if (salonId) applySubscription(salonId, obj);
      return;
    }
    case 'invoice.payment_failed': {
      const row = platform.prepare('SELECT id FROM salons WHERE stripe_customer_id = ?').get(String(obj.customer || ''));
      if (row) updateSalon(row.id, { status: 'past_due' });
      return;
    }
  }
}
