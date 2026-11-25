// Envio automático pelo WhatsApp (API oficial da Meta: WhatsApp Business Cloud API)
//
// Variáveis de ambiente (todas necessárias para o envio automático):
//   WHATSAPP_TOKEN             token de acesso permanente (usuário do sistema)
//   WHATSAPP_PHONE_NUMBER_ID   ID do número que envia
//   WHATSAPP_TEMPLATE_VESPERA  modelo aprovado do lembrete da véspera
//   WHATSAPP_TEMPLATE_2H       modelo aprovado do aviso 2h antes
// Opcionais:
//   WHATSAPP_TEMPLATE_VAGA     modelo "vagou um horário para você" (fila de espera)
//   WHATSAPP_TEMPLATE_LANG     idioma dos modelos (padrão pt_BR)
//   WHATSAPP_APP_SECRET        segredo do app: confere a assinatura das respostas recebidas
//   WHATSAPP_VERIFY_TOKEN      texto combinado para a Meta validar o webhook
//   WHATSAPP_API_VERSION       versão da Graph API (padrão v21.0)
//
// Mensagens iniciadas pelo salão só podem sair como MODELO aprovado pela Meta.
// Quando a cliente responde, abre-se uma janela de 24h em que dá para responder com texto livre.
// Todos os modelos recebem as mesmas 5 variáveis: {{1}} nome, {{2}} salão, {{3}} serviço, {{4}} quando, {{5}} link.
import { createHmac, timingSafeEqual } from 'node:crypto';

const env = process.env;
const VERSION = env.WHATSAPP_API_VERSION || 'v21.0';
const LANG = env.WHATSAPP_TEMPLATE_LANG || 'pt_BR';
export const TEMPLATES = { vespera: env.WHATSAPP_TEMPLATE_VESPERA, '2h': env.WHATSAPP_TEMPLATE_2H, vaga: env.WHATSAPP_TEMPLATE_VAGA };

export const whatsappEnabled = !!(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && TEMPLATES.vespera && TEMPLATES['2h']);

async function graph(body) {
  const res = await fetch(`${env.WHATSAPP_API_BASE || 'https://graph.facebook.com'}/${VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`WhatsApp: ${data.error?.message || res.status}`);
  return data.messages?.[0]?.id || null;
}

/** Envia um modelo aprovado. `to` com DDI (5511...). */
export function sendTemplate(to, kind, params) {
  const name = TEMPLATES[kind];
  if (!name) throw new Error(`Modelo de WhatsApp "${kind}" não configurado`);
  return graph({
    to, type: 'template',
    template: { name, language: { code: LANG }, components: [{ type: 'body', parameters: params.map(text => ({ type: 'text', text: String(text) })) }] },
  });
}

/** Texto livre: só vale dentro das 24h depois da última mensagem da cliente. */
export const sendText = (to, text) => graph({ to, type: 'text', text: { body: text, preview_url: true } });

/** Confere o cabeçalho X-Hub-Signature-256 ("sha256=<hex>") com o segredo do app. */
export function verifySignature(raw, header) {
  if (!env.WHATSAPP_APP_SECRET) throw new Error('WHATSAPP_APP_SECRET não configurado');
  const got = Buffer.from(String(header || '').replace(/^sha256=/, ''), 'hex');
  const expected = createHmac('sha256', env.WHATSAPP_APP_SECRET).update(raw).digest();
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new Error('Assinatura do WhatsApp inválida');
}

/** Validação do webhook pela Meta (GET com hub.challenge). Devolve o texto a responder, ou null. */
export function verifyChallenge(query) {
  if (query.get('hub.mode') === 'subscribe' && env.WHATSAPP_VERIFY_TOKEN && query.get('hub.verify_token') === env.WHATSAPP_VERIFY_TOKEN) {
    return query.get('hub.challenge') || '';
  }
  return null;
}

/** Mensagens recebidas no corpo do webhook: [{ from, text }] */
export function parseInbound(payload) {
  const out = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry.changes || []) {
      for (const m of change.value?.messages || []) {
        const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title;
        if (m.from && text) out.push({ from: String(m.from), text: String(text) });
      }
    }
  }
  return out;
}
