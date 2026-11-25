// Agente de lembretes e confirmações
//
// A cada minuto, para cada salão com o agente no plano:
//   - véspera: a partir do horário escolhido pelo salão (padrão 18:00), lembra as clientes de amanhã
//     e pede confirmação por um link pessoal (/c/<token>)
//   - 2h antes: aviso curto no dia
//   - vaga: quem saiu da fila de espera com um horário é avisada (só no envio automático)
//
// Canais:
//   whatsapp  envio automático pela API da Meta (modelos aprovados); as respostas da cliente
//             chegam pelo webhook e a IA entende se ela confirmou, desmarcou, quer remarcar ou perguntou algo
//   manual    sem a API da Meta: o agente escreve a mensagem e ela aparece no painel para enviar com um toque
//
// O link de confirmação funciona nos dois canais: a cliente confirma ou desmarca sem precisar responder.
import { randomBytes } from 'node:crypto';
import { platform, runAsSalon, db, getSettings, setSetting } from '../db.js';
import { agentsAllowed } from '../billing.js';
import { aiEnabled, writeReminder, interpretReply, interpretReplyRules } from './ia.js';
import { whatsappEnabled, TEMPLATES, sendTemplate, sendText } from './whatsapp.js';

const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${Number(process.env.PORT) || 3000}`).replace(/\/$/, '');

// funções do servidor (agenda, cancelamento): injetadas para não duplicar regras
let deps = null;
export function initReminders(d) { deps = d; }

// ---------------------------------------------------------------- datas
const pad = n => String(n).padStart(2, '0');
const toHHMM = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const parseHHMM = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '')); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null; };
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localStamp = d => `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return localDate(new Date(y, m - 1, d + n)); };
const dateObj = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const minutesOf = d => d.getHours() * 60 + d.getMinutes();
const firstName = n => String(n).trim().split(/\s+/)[0];
const digits = s => String(s ?? '').replace(/\D/g, '');
const waNumber = d => { d = digits(d); return d.length <= 11 ? '55' + d : d; };
const apptStart = a => new Date(dateObj(a.date).getTime() + a.start_min * 60000);

/** "amanhã, quinta-feira (26/11) às 09:00" / "hoje às 15:30" / "sexta-feira (27/11) às 10:00" */
function fmtWhen(a, now = new Date()) {
  const today = localDate(now);
  const time = toHHMM(a.start_min);
  if (a.date === today) return `hoje às ${time}`;
  const day = dateObj(a.date).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' }).replace(', ', ' (') + ')';
  return `${a.date === addDays(today, 1) ? 'amanhã, ' : ''}${day} às ${time}`;
}

function logEvent(salonId, appointmentId, kind, detail = '') {
  platform.prepare('INSERT INTO agent_events (salon_id, appointment_id, kind, detail) VALUES (?, ?, ?, ?)')
    .run(salonId, appointmentId, kind, String(detail).slice(0, 500));
}

function reminderSettings() {
  const s = getSettings();
  return {
    enabled: (s.reminders_enabled ?? '1') === '1',
    hour: s.reminder_hour || '18:00',
    twoHours: (s.reminder_2h ?? '1') === '1',
  };
}

// ---------------------------------------------------------------- mensagens
const SUFFIX = {
  vespera: link => `\n\nConfirme ou desmarque aqui: ${link}`,
  '2h': link => `\n\nSe não puder vir, avise aqui: ${link}`,
  vaga: link => `\n\nConfirme ou desmarque aqui: ${link}`,
};

function defaultText(kind, f, link) {
  const body = {
    vespera: `Oi, ${f.cliente}! Passando para lembrar do seu horário de ${f.servico} com ${f.profissional} ${f.quando}, aqui no ${f.salao}. 💅`,
    '2h': `Oi, ${f.cliente}! Seu horário de ${f.servico} com ${f.profissional} é ${f.quando}. Te esperamos no ${f.salao}!`,
    vaga: `Oi, ${f.cliente}! Boa notícia: vagou o horário de ${f.servico} ${f.quando} no ${f.salao} e ele é seu.`,
  }[kind];
  return body + SUFFIX[kind](link);
}

/** Cria (e, no automático, envia) o lembrete de um agendamento. Não repete: um por tipo e agendamento. */
async function createReminder(kind, salon, a, now = new Date()) {
  if (platform.prepare('SELECT 1 FROM reminders WHERE salon_id = ? AND appointment_id = ? AND kind = ?').get(salon.id, a.id, kind)) return false;

  const s = getSettings();
  const token = randomBytes(18).toString('base64url');
  const link = `${PUBLIC_URL}/c/${token}`;
  const phone = waNumber(a.customer_phone);
  const facts = {
    kind, salao: s.shop_name || salon.name, cliente: firstName(a.customer_name), servico: a.service_name,
    profissional: a.pro_name, quando: fmtWhen(a, now), endereco: s.address || '',
  };
  const auto = whatsappEnabled && !!TEMPLATES[kind];

  let message = null, ai = 0;
  if (!auto && aiEnabled && kind !== 'vaga') {
    try { message = (await writeReminder(facts)) + SUFFIX[kind](link); ai = 1; }
    catch (err) { console.warn(`[lembretes] IA indisponível, usando texto padrão: ${err.message}`); }
  }
  message ??= defaultText(kind, facts, link);

  const ins = platform.prepare(`INSERT OR IGNORE INTO reminders (salon_id, appointment_id, kind, phone, token, channel, message, ai)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(salon.id, a.id, kind, phone, token, auto ? 'whatsapp' : 'manual', message, ai);
  if (!ins.changes) return false; // outra execução criou ao mesmo tempo
  const id = Number(ins.lastInsertRowid);
  if (kind !== '2h') db.prepare(`UPDATE appointments SET confirmation = 'pending' WHERE id = ? AND confirmation = ''`).run(a.id);

  if (auto) {
    try {
      await sendTemplate(phone, kind, [facts.cliente, facts.salao, facts.servico, facts.quando, link]);
      platform.prepare(`UPDATE reminders SET status = 'sent', sent_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
      if (kind === 'vaga') db.prepare('UPDATE waitlist SET notified = 1 WHERE appointment_id = ?').run(a.id);
    } catch (err) {
      // não chegou pelo automático: vai para a lista de envio com um toque no painel
      platform.prepare(`UPDATE reminders SET channel = 'manual', error = ? WHERE id = ?`).run(err.message, id);
      logEvent(salon.id, a.id, 'failed', `${a.customer_name}: ${err.message}`);
    }
  }
  return true;
}

// ---------------------------------------------------------------- execução periódica
/** Cria os lembretes devidos agora para o salão (chamar dentro de runAsSalon). */
export async function runSalon(salon, now = new Date()) {
  const cfg = reminderSettings();
  const today = localDate(now), nowMin = minutesOf(now);
  let created = 0;

  // véspera: depois do horário escolhido e antes das 21:30 (não manda mensagem tarde da noite).
  // Quem agendou depois desse horário acabou de marcar: não precisa de lembrete da véspera.
  const hour = parseHHMM(cfg.hour) ?? 18 * 60;
  if (cfg.enabled && nowMin >= hour && nowMin < 21 * 60 + 30) {
    const rows = db.prepare(`${deps.APPT_SELECT} WHERE a.date = ? AND a.status = 'confirmed' AND a.confirmation != 'confirmed'
                             AND a.created_at < ? ORDER BY a.start_min`).all(addDays(today, 1), `${today} ${toHHMM(hour)}:00`);
    for (const a of rows) if (await createReminder('vespera', salon, a, now)) created++;
  }

  // 2h antes: entre 2h15 e 1h antes do horário; não avisa quem agendou há menos de 3 horas
  if (cfg.twoHours) {
    const rows = db.prepare(`${deps.APPT_SELECT} WHERE a.date = ? AND a.status = 'confirmed'
                             AND a.start_min - ? BETWEEN 60 AND 135 AND a.created_at < ?`)
      .all(today, nowMin, localStamp(new Date(now.getTime() - 3 * 3600_000)));
    for (const a of rows) if (await createReminder('2h', salon, a, now)) created++;
  }

  // vaga da fila de espera: só no envio automático (sem ele, o painel já mostra o aviso com o botão do WhatsApp)
  if (whatsappEnabled && TEMPLATES.vaga) {
    const rows = db.prepare(`${deps.APPT_SELECT} JOIN waitlist w2 ON w2.appointment_id = a.id
                             WHERE w2.status = 'promoted' AND w2.notified = 0 AND a.status = 'confirmed' AND a.date >= ?`).all(today);
    for (const a of rows) if (apptStart(a) > now && await createReminder('vaga', salon, a, now)) created++;
  }
  return created;
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    for (const salon of platform.prepare('SELECT * FROM salons').all()) {
      if (!agentsAllowed(salon)) continue;
      try { await runAsSalon(salon.id, () => runSalon(salon)); }
      catch (err) { console.error(`[lembretes] salão ${salon.id}:`, err); }
    }
  } finally {
    running = false;
  }
}

export function startReminderScheduler() {
  setTimeout(tick, 5_000);
  return setInterval(tick, 60_000);
}

// ---------------------------------------------------------------- link de confirmação (/c/<token>)
function reminderByToken(token) {
  const r = /^[\w-]{20,40}$/.test(String(token)) && platform.prepare('SELECT * FROM reminders WHERE token = ?').get(String(token));
  return r || deps.fail('Link inválido ou expirado.', 404);
}

function confirmationView(salon, a) {
  const s = getSettings();
  return {
    salao: s.shop_name || salon.name, slug: salon.slug, endereco: s.address || '',
    cliente: firstName(a.customer_name), servico: a.service_name, profissional: a.pro_name,
    quando: fmtWhen(a), data: a.date, horario: toHHMM(a.start_min),
    status: a.status, confirmation: a.confirmation, passou: apptStart(a) <= new Date(),
  };
}

export function confirmationInfo(token) {
  const r = reminderByToken(token);
  const salon = deps.getSalon(r.salon_id) || deps.fail('Link inválido ou expirado.', 404);
  return runAsSalon(salon.id, () => {
    const a = deps.getAppointment(r.appointment_id) || deps.fail('Agendamento não encontrado.', 404);
    return confirmationView(salon, a);
  });
}

export function confirmationAction(token, action, reason) {
  const r = reminderByToken(token);
  const salon = deps.getSalon(r.salon_id) || deps.fail('Link inválido ou expirado.', 404);
  return runAsSalon(salon.id, () => {
    const a = deps.getAppointment(r.appointment_id) || deps.fail('Agendamento não encontrado.', 404);
    if (a.status !== 'confirmed') deps.fail('Este horário não está mais ativo.');
    if (apptStart(a) <= new Date()) deps.fail('O horário já passou.');
    if (action === 'confirm') {
      applyConfirm(salon, a, 'pelo link');
    } else if (action === 'decline') {
      applyDecline(salon, a, String(reason || '').trim().replace(/\s+/g, ' ').slice(0, 300) || 'Desmarcou pelo lembrete', 'pelo link');
    } else {
      deps.fail('Ação inválida');
    }
    return confirmationView(salon, deps.getAppointment(a.id));
  });
}

function applyConfirm(salon, a, how) {
  db.prepare(`UPDATE appointments SET confirmation = 'confirmed', confirmed_at = datetime('now', 'localtime') WHERE id = ?`).run(a.id);
  logEvent(salon.id, a.id, 'confirmed', `${a.customer_name} confirmou ${how} · ${a.service_name}, ${fmtWhen(a)}`);
}

function applyDecline(salon, a, reason, how) {
  // mesmo caminho do cancelamento pelo site: o horário vai para a fila de espera e o painel avisa
  deps.cancelAppointment(a, { reason, by: 'cliente' });
  logEvent(salon.id, a.id, 'declined', `${a.customer_name} desmarcou ${how} · ${a.service_name}, ${fmtWhen(a)} · Motivo: ${reason}`);
}

// ---------------------------------------------------------------- respostas pelo WhatsApp
const DEFAULT_REPLY = {
  confirm: 'Obrigada! Seu horário está confirmado. Até lá! 💅',
  decline: 'Tudo bem, seu horário foi desmarcado. Quando quiser, é só agendar de novo.',
  reschedule: 'Claro! Escolha um novo horário pelo link abaixo. Seu horário atual continua marcado até você desmarcar.',
  question: 'Recebemos sua mensagem! O salão vai te responder em breve.',
  other: 'Recebemos sua mensagem! Qualquer coisa, é só chamar.',
};

/** Resposta de uma cliente a um lembrete (chega pelo webhook do WhatsApp). */
export async function handleInbound({ from, text }) {
  // casa pelos 8 últimos dígitos: o WhatsApp às vezes manda celulares sem o nono dígito
  const since = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const r = platform.prepare(`SELECT * FROM reminders WHERE substr(phone, -8) = ? AND status = 'sent' AND created_at >= ?
                              ORDER BY id DESC LIMIT 1`).get(digits(from).slice(-8), since);
  if (!r) return { ignored: true };
  const salon = deps.getSalon(r.salon_id);
  if (!salon) return { ignored: true };

  return runAsSalon(salon.id, async () => {
    const a = deps.getAppointment(r.appointment_id);
    if (!a) return { ignored: true };
    const s = getSettings();
    const active = a.status === 'confirmed' && apptStart(a) > new Date();

    let res = null;
    if (aiEnabled) {
      const context = {
        salao: s.shop_name || salon.name, endereco: s.address || '', telefone: s.phone || '',
        cliente: firstName(a.customer_name), servico: a.service_name, profissional: a.pro_name, quando: fmtWhen(a),
        situacao_do_horario: active ? 'marcado' : 'não está mais ativo (cancelado ou já passou)',
        servicos: db.prepare('SELECT name, price_cents, duration_min FROM services WHERE active = 1 ORDER BY sort, id').all()
          .map(x => `${x.name}: R$ ${(x.price_cents / 100).toFixed(2).replace('.', ',')}, ${x.duration_min} min`),
      };
      try { res = await interpretReply(context, text); }
      catch (err) { console.warn(`[lembretes] IA indisponível para entender a resposta: ${err.message}`); }
    }
    res ??= { ...interpretReplyRules(text), reply: null };

    let reply = res.reply || DEFAULT_REPLY[res.intent];
    if (['confirm', 'decline'].includes(res.intent) && !active) {
      reply = `Esse horário não está mais ativo. Para agendar de novo: ${PUBLIC_URL}/s/${salon.slug}`;
    } else if (res.intent === 'confirm') {
      applyConfirm(salon, a, 'pelo WhatsApp');
    } else if (res.intent === 'decline') {
      applyDecline(salon, a, res.reason || 'Avisou pelo WhatsApp que não vai', 'pelo WhatsApp');
    } else if (res.intent === 'reschedule') {
      reply += `\n${PUBLIC_URL}/s/${salon.slug}`;
      logEvent(salon.id, a.id, 'reschedule', `${a.customer_name} quer remarcar ${a.service_name}, ${fmtWhen(a)}: "${text}"`);
    } else {
      logEvent(salon.id, a.id, 'question', `${a.customer_name} escreveu: "${text}"`);
    }

    try { await sendText(waNumber(from), reply); }
    catch (err) { logEvent(salon.id, a.id, 'failed', `Resposta para ${a.customer_name} não saiu: ${err.message}`); }
    return { intent: res.intent, reply };
  });
}

// ---------------------------------------------------------------- painel
export function panelData(salon) {
  const cfg = reminderSettings();
  const now = new Date(), today = localDate(now), tomorrow = addDays(today, 1);

  // lembretes esperando o envio com um toque (some quando o horário passa ou é cancelado)
  const queue = platform.prepare(`SELECT * FROM reminders WHERE salon_id = ? AND channel = 'manual' AND status = 'queued' ORDER BY id`).all(salon.id)
    .map(r => ({ r, a: deps.getAppointment(r.appointment_id) }))
    .filter(({ r, a }) => a && a.status === 'confirmed' && apptStart(a) > now
      && !(r.kind !== '2h' && a.confirmation === 'confirmed')) // já confirmou: não precisa mais do lembrete
    .map(({ r, a }) => ({
      id: r.id, kind: r.kind, message: r.message, ai: !!r.ai, error: r.error,
      customerName: a.customer_name, date: a.date, start: toHHMM(a.start_min), serviceName: a.service_name,
      url: `https://wa.me/${r.phone}?text=${encodeURIComponent(r.message)}`,
    }));

  const count = date => db.prepare(`SELECT confirmation c, COUNT(*) n FROM appointments WHERE date = ? AND status = 'confirmed' GROUP BY confirmation`)
    .all(date).reduce((o, x) => ({ ...o, [x.c || 'none']: x.n }), { confirmed: 0, pending: 0, none: 0 });

  const events = platform.prepare('SELECT id, kind, detail, created_at FROM agent_events WHERE salon_id = ? ORDER BY id DESC LIMIT 25').all(salon.id);
  return {
    allowed: agentsAllowed(salon), channel: whatsappEnabled ? 'whatsapp' : 'manual', ai: aiEnabled,
    settings: cfg, queue, events, today: count(today), tomorrow: count(tomorrow),
  };
}

export function saveReminderSettings(body) {
  if ('enabled' in body) setSetting('reminders_enabled', body.enabled ? '1' : '0');
  if ('twoHours' in body) setSetting('reminder_2h', body.twoHours ? '1' : '0');
  if ('hour' in body) {
    const m = parseHHMM(body.hour);
    if (m == null || m < 8 * 60 || m > 21 * 60) deps.fail('Horário do lembrete: escolha entre 08:00 e 21:00');
    setSetting('reminder_hour', toHHMM(m));
  }
  return reminderSettings();
}

export function markSent(salon, id) {
  const r = platform.prepare(`UPDATE reminders SET status = 'sent', sent_at = ? WHERE id = ? AND salon_id = ? AND channel = 'manual'`)
    .run(new Date().toISOString(), Number(id), salon.id);
  if (!r.changes) deps.fail('Lembrete não encontrado', 404);
  return { ok: true };
}
