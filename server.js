// nAIls: servidor HTTP + API REST do SaaS de agendamento para nail designers (sem dependências externas)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomInt, createHash } from 'node:crypto';
import { db, platform, runAsSalon, initSalonDb, getSettings, setSetting, verifyPassword, hashPassword, tx } from './db.js';
import { PLANS, TRIAL_DAYS, BILLING_MODE, BillingError, salonAccess, maxProsFor, agentsAllowed,
  startCheckout, billingPortal, cancelDemo, syncCheckout, verifyWebhook, handleWebhookEvent } from './billing.js';
import { initReminders, startReminderScheduler, runSalon, panelData, saveReminderSettings, markSent,
  confirmationInfo, confirmationAction, handleInbound } from './agents/lembretes.js';
import { whatsappEnabled, verifySignature, verifyChallenge, parseInbound } from './agents/whatsapp.js';
import { aiEnabled } from './agents/ia.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT) || 3000;

// ---------------------------------------------------------------- utilitários
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (msg, status = 400) => { throw new HttpError(status, msg); };

const pad = n => String(n).padStart(2, '0');
const toHHMM = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const parseHHMM = s => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? ''));
  if (!m || +m[2] > 59) return null;
  const v = +m[1] * 60 + +m[2];
  return v <= 1440 ? v : null;
};
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? '')) && localDate(toDateObj(s)) === s;
const toDateObj = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = toDateObj(s); d.setDate(d.getDate() + n); return localDate(d); };
const weekday = s => toDateObj(s).getDay();
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const digits = s => String(s ?? '').replace(/\D/g, '');
const str = (s, max = 200) => String(s ?? '').trim().slice(0, max);
const int = (v, name, min = 0, max = 1e9) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(`${name} inválido`);
  return n;
};

// ---------------------------------------------------------------- mensagens de WhatsApp
// O envio é feito pelo próprio WhatsApp de quem cancela: o link wa.me abre a conversa com o texto
// pronto, e a pessoa só toca em "enviar". (Envio 100% automático exigiria a API paga do WhatsApp Business.)
const waNumber = d => { d = digits(d); return d.length <= 11 ? '55' + d : d; };
const waLink = (phone, text) => `https://wa.me/${waNumber(phone)}?text=${encodeURIComponent(text)}`;
/** "sexta-feira, 13/11 às 10:00" */
const fmtWhen = (date, startMin) =>
  `${toDateObj(date).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' })} às ${toHHMM(startMin)}`;
const firstName = name => String(name).trim().split(/\s+/)[0];

const PUBLIC_SETTINGS = ['shop_name', 'about', 'address', 'phone', 'whatsapp', 'instagram',
  'slot_step', 'min_advance_min', 'max_days_ahead', 'cancel_advance_min'];
const STATUSES = ['confirmed', 'completed', 'cancelled', 'no_show'];

// ---------------------------------------------------------------- disponibilidade
function getWorkingHours(proId, wd) {
  return db.prepare('SELECT * FROM working_hours WHERE pro_id = ? AND weekday = ?').get(proId, wd);
}

/**
 * Estado de cada horário de uma profissional numa data, para um serviço de `duration` minutos:
 *   'free'  = livre
 *   'taken' = ocupado por outro cliente (dá para entrar na fila de espera)
 * Horários fora do expediente, no intervalo, bloqueados ou já passados ficam fora do mapa.
 */
function slotStates(proId, date, duration, { admin = false } = {}) {
  const states = new Map();
  const s = getSettings();
  const today = localDate();
  if (!admin && (date < today || date > addDays(today, +s.max_days_ahead))) return states;

  const wh = getWorkingHours(proId, weekday(date));
  if (!wh) return states;

  const appts = db.prepare(`SELECT start_min s, end_min e FROM appointments
                            WHERE pro_id = ? AND date = ? AND status != 'cancelled'`).all(proId, date);
  const fixed = db.prepare(`SELECT start_min s, end_min e FROM blocks
                            WHERE date = ? AND (pro_id IS NULL OR pro_id = ?)`).all(date, proId);
  if (wh.break_start != null && wh.break_end != null) fixed.push({ s: wh.break_start, e: wh.break_end });

  let earliest = wh.start_min;
  if (date === today) earliest = Math.max(earliest, nowMin() + (admin ? 0 : +s.min_advance_min));

  const step = Math.max(5, +s.slot_step || 15);
  const overlaps = t => b => t < b.e && t + duration > b.s;
  for (let t = wh.start_min; t + duration <= wh.end_min; t += step) {
    if (t < earliest || fixed.some(overlaps(t))) continue;
    states.set(t, appts.some(overlaps(t)) ? 'taken' : 'free');
  }
  return states;
}

function activePros() {
  return db.prepare('SELECT id, name FROM pros WHERE active = 1 ORDER BY name').all();
}

/** Horários do dia: `available` = dá para agendar; senão está ocupado e `queue` diz quantos já esperam por ele. */
function availability(date, service, proId, opts) {
  const pros = proId ? activePros().filter(b => b.id === proId) : activePros();
  const map = new Map(); // horário -> profissionais livres (vazio = todos ocupados)
  for (const b of pros) {
    for (const [t, state] of slotStates(b.id, date, service.duration_min, opts)) {
      if (!map.has(t)) map.set(t, []);
      if (state === 'free') map.get(t).push(b.id);
    }
  }
  const queue = new Map(db.prepare(`SELECT start_min t, COUNT(*) n FROM waitlist
                                    WHERE status = 'waiting' AND date = ? GROUP BY start_min`).all(date).map(r => [r.t, r.n]));
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([t, ids]) => ({
    time: toHHMM(t), available: ids.length > 0, proIds: ids, queue: ids.length ? 0 : (queue.get(t) || 0),
  }));
}

/** Profissional livre para o horário (o pedido, ou o menos ocupado do dia se "qualquer um"). null = ninguém livre. */
function pickPro(proId, date, start, duration, opts) {
  const active = activePros().map(b => b.id);
  const candidates = (proId ? [proId] : active)
    .filter(id => active.includes(id))
    .filter(id => slotStates(id, date, duration, opts).get(start) === 'free');
  if (!candidates.length) return null;
  const load = id => db.prepare(`SELECT COUNT(*) n FROM appointments
                                 WHERE pro_id = ? AND date = ? AND status != 'cancelled'`).get(id, date).n;
  return candidates.sort((a, b) => load(a) - load(b))[0];
}

// ---------------------------------------------------------------- agendamentos
const APPT_SELECT = `SELECT a.*, s.name AS service_name, b.name AS pro_name, (w.id IS NOT NULL) AS from_waitlist
                     FROM appointments a JOIN services s ON s.id = a.service_id JOIN pros b ON b.id = a.pro_id
                     LEFT JOIN waitlist w ON w.appointment_id = a.id`;
const WAIT_SELECT = `SELECT w.*, s.name AS service_name, b.name AS pro_name
                     FROM waitlist w JOIN services s ON s.id = w.service_id LEFT JOIN pros b ON b.id = w.pro_id`;

const getAppointment = id => db.prepare(`${APPT_SELECT} WHERE a.id = ?`).get(id);

function apptView(a) {
  return {
    kind: 'appointment',
    id: a.id, code: a.code, date: a.date, start: toHHMM(a.start_min), end: toHHMM(a.end_min),
    serviceId: a.service_id, serviceName: a.service_name, proId: a.pro_id, proName: a.pro_name,
    customerName: a.customer_name, customerPhone: a.customer_phone, notes: a.notes,
    priceCents: a.price_cents, status: a.status, fromWaitlist: !!a.from_waitlist, createdAt: a.created_at,
    cancelReason: a.cancel_reason || '', cancelledBy: a.cancelled_by || null, cancelledAt: a.cancelled_at || null,
    confirmation: a.confirmation || '', // agente de lembretes: '' | pending | confirmed
  };
}

function waitView(w) {
  const today = localDate();
  const past = w.date < today || (w.date === today && w.start_min <= nowMin());
  const waiting = w.status === 'waiting' && !past;
  return {
    kind: 'waitlist',
    id: w.id, code: w.code, date: w.date, start: toHHMM(w.start_min),
    serviceId: w.service_id, serviceName: w.service_name, proId: w.pro_id, proName: w.pro_name ?? null,
    customerName: w.customer_name, customerPhone: w.customer_phone, notes: w.notes,
    status: w.status === 'waiting' && past ? 'expired' : w.status,
    // lugar na fila daquele horário (1 = próximo a ser chamado)
    position: waiting ? db.prepare(`SELECT COUNT(*) n FROM waitlist WHERE status = 'waiting' AND date = ? AND start_min = ? AND id <= ?`)
      .get(w.date, w.start_min, w.id).n : null,
    createdAt: w.created_at,
  };
}

// Código único entre agendamentos e fila: quem sai da fila mantém o mesmo código no agendamento.
function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    const code = Array.from({ length: 6 }, () => chars[randomInt(chars.length)]).join('');
    if (!db.prepare('SELECT 1 FROM appointments WHERE code = ? UNION SELECT 1 FROM waitlist WHERE code = ?').get(code, code)) return code;
  }
}

function getService(id) {
  const s = db.prepare('SELECT * FROM services WHERE id = ? AND active = 1').get(Number(id));
  return s || fail('Serviço não encontrado');
}

function parseBooking(body) {
  const service = getService(body.serviceId);
  const date = isDate(body.date) ? body.date : fail('Data inválida');
  const start = parseHHMM(body.time) ?? fail('Horário inválido');
  const name = str(body.name, 80);
  const phone = digits(body.phone);
  if (name.length < 2) fail('Informe seu nome');
  if (phone.length < 10 || phone.length > 13) fail('Informe um telefone válido com DDD');
  return { service, date, start, name, phone, notes: str(body.notes, 300), proId: body.proId ? Number(body.proId) : null };
}

function insertAppointment({ code, proId, service, date, start, name, phone, notes }) {
  const info = db.prepare(`INSERT INTO appointments
      (code, pro_id, service_id, date, start_min, end_min, customer_name, customer_phone, notes, price_cents)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(code, proId, service.id, date, start, start + service.duration_min, name, phone, notes, service.price_cents);
  return getAppointment(info.lastInsertRowid);
}

function createAppointment(body, { admin = false } = {}) {
  const b = parseBooking(body);
  // Node é single-thread e o SQLite aqui é síncrono: checar + inserir é atômico.
  const chosen = pickPro(b.proId, b.date, b.start, b.service.duration_min, { admin });
  if (chosen == null) {
    fail(admin ? 'Esse horário não está livre.' : 'Esse horário acabou de ser ocupado. Entre na fila de espera ou escolha outro.', 409);
  }
  return apptView(insertAppointment({ ...b, code: newCode(), proId: chosen }));
}

// ---------------------------------------------------------------- fila de espera
function joinWaitlist(body) {
  const b = parseBooking(body);
  const slot = availability(b.date, b.service, b.proId).find(s => s.time === toHHMM(b.start));
  if (!slot) fail('Esse horário não está disponível para fila de espera.');
  if (slot.available) return createAppointment(body); // vagou nesse meio-tempo: já agenda direto

  const mine = [b.phone, b.date, b.start];
  if (db.prepare(`SELECT 1 FROM appointments WHERE customer_phone = ? AND date = ? AND start_min = ? AND status = 'confirmed'`).get(...mine)) {
    fail('Você já tem um agendamento neste horário.');
  }
  if (db.prepare(`SELECT 1 FROM waitlist WHERE customer_phone = ? AND date = ? AND start_min = ? AND status = 'waiting'`).get(...mine)) {
    fail('Você já está na fila de espera deste horário.');
  }
  const open = db.prepare(`SELECT COUNT(*) n FROM waitlist WHERE customer_phone = ? AND status = 'waiting' AND date >= ?`).get(b.phone, localDate()).n;
  if (open >= 5) fail('Você já está em 5 filas de espera. Saia de alguma para entrar em outra.');

  const id = db.prepare(`INSERT INTO waitlist (code, pro_id, service_id, date, start_min, customer_name, customer_phone, notes)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(newCode(), b.proId, b.service.id, b.date, b.start, b.name, b.phone, b.notes).lastInsertRowid;
  return waitView(db.prepare(`${WAIT_SELECT} WHERE w.id = ?`).get(id));
}

/**
 * Chamado sempre que algum horário pode ter vagado (cancelamento, bloqueio removido, expediente alterado).
 * Quem está na fila ganha o horário automaticamente, por ordem de chegada; o dono é avisado no painel.
 * Devolve os agendamentos criados a partir da fila.
 */
function processWaitlist() {
  const promoted = [];
  const waiting = db.prepare(`SELECT * FROM waitlist WHERE status = 'waiting' AND date >= ? ORDER BY id`).all(localDate());
  for (const w of waiting) {
    const service = db.prepare('SELECT * FROM services WHERE id = ? AND active = 1').get(w.service_id);
    if (!service) continue;
    const proId = pickPro(w.pro_id, w.date, w.start_min, service.duration_min);
    if (proId == null) continue;
    tx(() => {
      const a = insertAppointment({
        code: w.code, proId, service, date: w.date, start: w.start_min,
        name: w.customer_name, phone: w.customer_phone, notes: w.notes,
      });
      db.prepare(`UPDATE waitlist SET status = 'promoted', appointment_id = ? WHERE id = ?`).run(a.id, w.id);
      promoted.push(a);
    });
  }
  return promoted;
}

/** Marca um agendamento como cancelado, guardando o motivo e quem cancelou, e libera o horário para a fila. */
function cancelAppointment(a, { reason, by }) {
  db.prepare(`UPDATE appointments SET status = 'cancelled', cancel_reason = ?, cancelled_by = ?,
              cancelled_at = datetime('now', 'localtime'), cancel_seen = ? WHERE id = ?`)
    .run(reason, by, by === 'cliente' ? 0 : 1, a.id);
  const promoted = processWaitlist();
  // alguém da fila de espera ficou com este mesmo horário?
  return promoted.find(p => p.pro_id === a.pro_id && p.date === a.date && p.start_min < a.end_min && p.end_min > a.start_min) || null;
}

/** Acha pelo código + telefone um agendamento ou, se não houver, um lugar na fila de espera. */
function findByCodeAndPhone(code, phone) {
  code = str(code, 10).toUpperCase();
  phone = digits(phone);
  const appt = db.prepare(`${APPT_SELECT} WHERE a.code = ?`).get(code);
  if (appt && appt.customer_phone === phone) return { appt };
  const wait = db.prepare(`${WAIT_SELECT} WHERE w.code = ?`).get(code);
  if (wait && wait.customer_phone === phone) return { wait };
  return fail('Agendamento não encontrado. Confira o código e o telefone.', 404);
}

// ---------------------------------------------------------------- contas e sessões
const loginFails = new Map(); // ip -> { n, until }
const signups = new Map();    // ip -> [instantes] (limita cadastros em massa)
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const sha256 = v => createHash('sha256').update(String(v)).digest('hex');
const bearer = req => (req.headers.authorization || '').replace(/^Bearer /, '');
const getSalon = id => platform.prepare('SELECT * FROM salons WHERE id = ?').get(id);

function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  platform.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  platform.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, Date.now() + SESSION_MS);
  return token;
}

/** Usuária logada e o salão dela, a partir do token. */
function requireAdmin(req) {
  const row = platform.prepare(`SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
                                WHERE s.token_hash = ?`).get(sha256(bearer(req)));
  if (!row || row.expires_at < Date.now()) fail('Sessão expirada. Entre novamente.', 401);
  return { user: row, salon: getSalon(row.salon_id) };
}

function checkLoginRate(ip) {
  const f = loginFails.get(ip);
  if (f && f.n >= 10 && f.until > Date.now()) fail('Muitas tentativas. Aguarde 15 minutos.', 429);
}
function loginFailed(ip) {
  const f = loginFails.get(ip);
  loginFails.set(ip, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + 15 * 60000 });
}

/** "Studio da Ana Paula" -> "studio-da-ana-paula" (sem repetir endereço de outro salão) */
function uniqueSlug(name) {
  const base = String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'salao';
  for (let i = 1; ; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    if (!platform.prepare('SELECT 1 FROM salons WHERE slug = ?').get(slug)) return slug;
  }
}

const isEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

// ---------------------------------------------------------------- rotas
const routes = [];
// scope: 'salon'    = página pública de um salão (/api/s/<slug>/...)
//        'admin'    = painel (salão da usuária logada)
//        'platform' = cadastro, login, planos (sem salão)
function route(method, pattern, handler, { admin = false, scope = admin ? 'admin' : 'salon' } = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, scope });
}

// ----- público
route('GET', '/api/info', ({ salon }) => {
  const s = getSettings();
  const settings = Object.fromEntries(PUBLIC_SETTINGS.map(k => [k, s[k] ?? '']));
  const services = db.prepare('SELECT id, name, description, price_cents, duration_min FROM services WHERE active = 1 ORDER BY sort, id').all();
  const pros = activePros().map(b => ({
    ...b,
    days: db.prepare('SELECT weekday FROM working_hours WHERE pro_id = ?').all(b.id).map(r => r.weekday),
  }));
  // Horário de funcionamento = união dos expedientes das profissionais ativas
  const hours = Array.from({ length: 7 }, (_, wd) => {
    const r = db.prepare(`SELECT MIN(start_min) o, MAX(end_min) c FROM working_hours h JOIN pros b ON b.id = h.pro_id
                          WHERE b.active = 1 AND h.weekday = ?`).get(wd);
    return r.o == null ? null : { open: toHHMM(r.o), close: toHHMM(r.c) };
  });
  return { settings, services, pros, hours, today: localDate(), online: salonAccess(salon).online };
});

route('GET', '/api/availability', ({ query }) => {
  const date = isDate(query.get('date')) ? query.get('date') : fail('Data inválida');
  const service = getService(query.get('serviceId'));
  const proId = query.get('proId') ? Number(query.get('proId')) : null;
  return { slots: availability(date, service, proId) };
});

// Sem assinatura (teste encerrado ou cancelada), a página continua no ar, mas não aceita agendamentos
const requireOnline = salon => salonAccess(salon).online || fail('A agenda online deste estúdio está pausada. Fale com o estúdio pelo WhatsApp.', 403);
route('POST', '/api/appointments', ({ body, salon }) => { requireOnline(salon); return createAppointment(body); });

route('POST', '/api/waitlist', ({ body, salon }) => { requireOnline(salon); return joinWaitlist(body); });

route('POST', '/api/appointments/lookup', ({ body }) => {
  const { appt, wait } = findByCodeAndPhone(body.code, body.phone);
  return appt ? apptView(appt) : waitView(wait);
});

route('POST', '/api/appointments/cancel', ({ body }) => {
  const { appt: a, wait: w } = findByCodeAndPhone(body.code, body.phone);
  if (w) { // sair da fila de espera
    if (w.status !== 'waiting') fail('Você não está mais nesta fila de espera.');
    db.prepare(`UPDATE waitlist SET status = 'cancelled' WHERE id = ?`).run(w.id);
    return waitView({ ...w, status: 'cancelled' });
  }
  if (a.status !== 'confirmed') fail('Este agendamento não pode mais ser cancelado.');
  const s = getSettings();
  const minutesUntil = (toDateObj(a.date).getTime() + a.start_min * 60000 - Date.now()) / 60000;
  if (minutesUntil < +s.cancel_advance_min) {
    fail(`Cancelamento online só até ${Math.round(+s.cancel_advance_min / 60 * 10) / 10}h antes. Fale com o estúdio.`);
  }
  // o cliente precisa dizer por que está cancelando
  const reason = str(body.reason, 300).replace(/\s+/g, ' ');
  if (reason.length < 3) fail('Conte o motivo do cancelamento.');

  cancelAppointment(a, { reason, by: 'cliente' });

  // mensagem pronta para o cliente mandar à profissional (ou ao estúdio, se ela não tiver WhatsApp cadastrado)
  const pro = db.prepare('SELECT name, whatsapp FROM pros WHERE id = ?').get(a.pro_id);
  const to = pro?.whatsapp || s.whatsapp;
  const text = [
    pro?.whatsapp ? `Olá, ${firstName(pro.name)}! Aqui é ${a.customer_name}.` : `Olá! Aqui é ${a.customer_name}.`,
    'Precisei cancelar meu horário:',
    '',
    `Serviço: ${a.service_name} com ${a.pro_name}`,
    `Horário: ${fmtWhen(a.date, a.start_min)}`,
    `Motivo: ${reason}`,
    `Código: ${a.code}`,
  ].join('\n');
  return {
    ...apptView(getAppointment(a.id)),
    notify: to ? { para: pro?.whatsapp ? a.pro_name : s.shop_name, url: waLink(to, text), texto: text } : null,
  };
});

// ----- plataforma: planos, cadastro e login
route('GET', '/api/platform/plans', () => ({ plans: PLANS, trialDays: TRIAL_DAYS, billingMode: BILLING_MODE }), { scope: 'platform' });

route('POST', '/api/platform/signup', ({ body, req }) => {
  const ip = req.socket.remoteAddress;
  const recent = (signups.get(ip) || []).filter(t => t > Date.now() - 3600_000);
  if (recent.length >= 5) fail('Muitos cadastros seguidos. Tente de novo em uma hora.', 429);

  const salonName = str(body.salonName, 60);
  const name = str(body.name, 80);
  const email = str(body.email, 120).toLowerCase();
  const password = String(body.password || '');
  const whatsapp = digits(body.whatsapp);
  if (salonName.length < 2) fail('Informe o nome do seu estúdio');
  if (name.length < 2) fail('Informe seu nome');
  if (!isEmail(email)) fail('E-mail inválido');
  if (password.length < 8) fail('A senha precisa ter pelo menos 8 caracteres');
  if (whatsapp && (whatsapp.length < 10 || whatsapp.length > 13)) fail('WhatsApp inválido: use DDD + número');
  if (platform.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) fail('Já existe uma conta com este e-mail. Entre com ela.', 409);
  const plan = PLANS[body.plan] ? body.plan : 'profissional';

  const { salonId, userId, slug } = tx(() => {
    const slug = uniqueSlug(salonName);
    const salonId = Number(platform.prepare('INSERT INTO salons (slug, name, plan, status, trial_ends_at) VALUES (?, ?, ?, ?, ?)')
      .run(slug, salonName, plan, 'trialing', new Date(Date.now() + TRIAL_DAYS * 86_400_000).toISOString()).lastInsertRowid);
    const userId = Number(platform.prepare('INSERT INTO users (salon_id, name, email, password_hash) VALUES (?, ?, ?, ?)')
      .run(salonId, name, email, hashPassword(password)).lastInsertRowid);
    return { salonId, userId, slug };
  }, platform);
  initSalonDb(salonId, { shopName: salonName, ownerName: firstName(name), whatsapp });
  signups.set(ip, [...recent, Date.now()]);
  return { token: createSession(userId), slug };
}, { scope: 'platform' });

route('POST', '/api/platform/login', ({ body, req }) => {
  const ip = req.socket.remoteAddress;
  checkLoginRate(ip);
  const user = platform.prepare('SELECT * FROM users WHERE email = ?').get(str(body.email, 120).toLowerCase());
  if (!user || !verifyPassword(body.password, user.password_hash)) {
    loginFailed(ip);
    fail('E-mail ou senha incorretos', 401);
  }
  loginFails.delete(ip);
  return { token: createSession(user.id) };
}, { scope: 'platform' });

// ----- painel: conta e assinatura
route('POST', '/api/admin/logout', ({ req }) => {
  platform.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(bearer(req)));
  return { ok: true };
}, { admin: true });

route('POST', '/api/admin/password', ({ body, user, req }) => {
  if (!verifyPassword(body.current, user.password_hash)) fail('Senha atual incorreta');
  if (String(body.next || '').length < 8) fail('A nova senha precisa ter pelo menos 8 caracteres');
  platform.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(body.next)), user.id);
  // encerra as outras sessões: quem tinha a senha antiga não continua logado
  platform.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(user.id, sha256(bearer(req)));
  return { ok: true };
}, { admin: true });

function accountView(user, salon) {
  const access = salonAccess(salon);
  return {
    user: { name: user.name, email: user.email },
    salon: {
      name: salon.name, slug: salon.slug, plan: salon.plan, planName: PLANS[salon.plan]?.name || salon.plan,
      status: salon.status, statusLabel: access.label, online: access.online, trialDaysLeft: access.trialDaysLeft,
      trialEndsAt: salon.trial_ends_at, currentPeriodEnd: salon.current_period_end,
      hasBilling: !!salon.stripe_customer_id, maxPros: maxProsFor(salon),
    },
    plans: PLANS, billingMode: BILLING_MODE,
  };
}
route('GET', '/api/admin/account', ({ user, salon }) => accountView(user, salon), { admin: true });

const originOf = req => String(req.headers.origin || `http://${req.headers.host}`);
route('POST', '/api/admin/billing/checkout', async ({ body, user, salon, req }) =>
  startCheckout(salon, user, String(body.plan || ''), originOf(req)), { admin: true });
route('POST', '/api/admin/billing/portal', ({ salon, req }) => billingPortal(salon, originOf(req)), { admin: true });
route('POST', '/api/admin/billing/cancel', ({ salon }) => { cancelDemo(salon); return { ok: true }; }, { admin: true });
route('POST', '/api/admin/billing/sync', async ({ body, user, salon }) => {
  await syncCheckout(salon, body.sessionId);
  return accountView(user, getSalon(salon.id));
}, { admin: true });

// ----- agente de lembretes
// Link pessoal da cliente (/c/<token>): confirmar ou desmarcar sem login
route('GET', '/api/confirmar/:token', ({ params }) => confirmationInfo(params.token), { scope: 'platform' });
route('POST', '/api/confirmar/:token', ({ params, body }) => confirmationAction(params.token, body.action, body.reason), { scope: 'platform' });

route('GET', '/api/admin/agentes', ({ salon }) => panelData(salon), { admin: true });
route('PUT', '/api/admin/agentes/lembretes', ({ body }) => saveReminderSettings(body), { admin: true });
route('POST', '/api/admin/agentes/lembretes/:id/enviado', ({ params, salon }) => markSent(salon, params.id), { admin: true });
route('POST', '/api/admin/agentes/rodar', async ({ salon, body }) => {
  if (!agentsAllowed(salon)) fail('O agente de lembretes está nos planos Profissional e Studio.', 403);
  // NAILS_TEST_CLOCK=1 (só em testes): simula outro instante, para testar véspera e 2h antes sem esperar
  const now = process.env.NAILS_TEST_CLOCK === '1' && body.now ? new Date(body.now) : new Date();
  const created = await runSalon(salon, now);
  return { created, ...panelData(salon) };
}, { admin: true });

// ----- admin: agenda
route('GET', '/api/admin/appointments', ({ query }) => {
  const from = isDate(query.get('from')) ? query.get('from') : localDate();
  const to = isDate(query.get('to')) ? query.get('to') : from;
  const rows = db.prepare(`${APPT_SELECT} WHERE a.date BETWEEN ? AND ? ORDER BY a.date, a.start_min, b.name`).all(from, to);
  return rows.map(apptView);
}, { admin: true });

route('GET', '/api/admin/availability', ({ query }) => {
  const date = isDate(query.get('date')) ? query.get('date') : fail('Data inválida');
  const service = getService(query.get('serviceId'));
  const proId = query.get('proId') ? Number(query.get('proId')) : null;
  return { slots: availability(date, service, proId, { admin: true }) };
}, { admin: true });

route('POST', '/api/admin/appointments', ({ body }) => createAppointment(body, { admin: true }), { admin: true });

route('PATCH', '/api/admin/appointments/:id', ({ params, body, req, salon }) => {
  if (!STATUSES.includes(body.status)) fail('Status inválido');
  const a = getAppointment(Number(params.id)) || fail('Não encontrado', 404);
  if (a.status === body.status) return apptView(a);

  // Estúdio cancelando: motivo opcional e mensagem pronta para avisar o cliente
  if (body.status === 'cancelled') {
    const reason = str(body.reason, 300).replace(/\s+/g, ' ');
    const taken = cancelAppointment(a, { reason, by: 'estudio' });
    const s = getSettings();
    const origin = String(req.headers.origin || `http://${req.headers.host}`);
    const site = /\/\/(localhost|127\.|\[::1\])/.test(origin) ? '' : `${origin}/s/${salon.slug}#agendar`; // link local não serve ao cliente
    const text = [
      `Olá, ${firstName(a.customer_name)}! Aqui é da ${s.shop_name}.`,
      `Infelizmente precisamos cancelar o seu horário de ${a.service_name} com ${a.pro_name}, ${fmtWhen(a.date, a.start_min)}.`,
      ...(reason ? [`Motivo: ${reason}`] : []),
      '',
      site ? `Pedimos desculpas. Para marcar outro horário: ${site}` : 'Pedimos desculpas. Responda esta mensagem para marcarmos outro horário.',
    ].join('\n');
    return {
      ...apptView(getAppointment(a.id)),
      notify: { para: a.customer_name, url: waLink(a.customer_phone, text), texto: text },
      filaOcupou: taken ? taken.customer_name : null,
    };
  }

  if (a.status === 'cancelled') {
    // reativar: só se o horário ainda estiver livre
    const conflict = db.prepare(`SELECT 1 FROM appointments WHERE pro_id = ? AND date = ? AND status != 'cancelled'
                                 AND id != ? AND start_min < ? AND end_min > ?`).get(a.pro_id, a.date, a.id, a.end_min, a.start_min);
    if (conflict) fail('O horário já foi ocupado por outro cliente.', 409);
    db.prepare(`UPDATE appointments SET cancel_reason = '', cancelled_by = NULL, cancelled_at = NULL, cancel_seen = 1 WHERE id = ?`).run(a.id);
  }
  db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(body.status, a.id);
  return apptView(getAppointment(a.id));
}, { admin: true });

// "Ok, visto": tira do topo do painel o aviso de cancelamento feito pelo cliente
route('POST', '/api/admin/appointments/:id/seen', ({ params }) => {
  db.prepare('UPDATE appointments SET cancel_seen = 1 WHERE id = ?').run(Number(params.id));
  return { ok: true };
}, { admin: true });

// ----- admin: fila de espera
route('GET', '/api/admin/waitlist', () => {
  const today = localDate();
  // quem ainda está aguardando
  const waiting = db.prepare(`${WAIT_SELECT} WHERE w.status = 'waiting' AND w.date >= ? ORDER BY w.date, w.start_min, w.id`)
    .all(today).map(waitView).filter(w => w.status === 'waiting');
  // quem ganhou a vaga e ainda não foi avisado pelo dono
  const toNotify = db.prepare(`SELECT w.id AS wait_id, a.id FROM waitlist w JOIN appointments a ON a.id = w.appointment_id
                               WHERE w.status = 'promoted' AND w.notified = 0 AND a.status = 'confirmed' AND a.date >= ?
                               ORDER BY a.date, a.start_min`)
    .all(today).map(r => ({ ...apptView(getAppointment(r.id)), waitId: r.wait_id }));
  // clientes que cancelaram pelo site e o painel ainda não viu
  const cancellations = db.prepare(`${APPT_SELECT} WHERE a.status = 'cancelled' AND a.cancelled_by = 'cliente'
                                    AND a.cancel_seen = 0 AND a.date >= ? ORDER BY a.cancelled_at`)
    .all(today).map(apptView);
  return { waiting, toNotify, cancellations };
}, { admin: true });
route('POST', '/api/admin/waitlist/:id/notified', ({ params }) => {
  db.prepare('UPDATE waitlist SET notified = 1 WHERE id = ?').run(Number(params.id));
  return { ok: true };
}, { admin: true });
route('DELETE', '/api/admin/waitlist/:id', ({ params }) => {
  db.prepare(`UPDATE waitlist SET status = 'cancelled' WHERE id = ? AND status = 'waiting'`).run(Number(params.id));
  return { ok: true };
}, { admin: true });

// ----- admin: serviços
route('GET', '/api/admin/services', () =>
  db.prepare('SELECT * FROM services ORDER BY sort, id').all(), { admin: true });

function serviceFields(b) {
  const name = str(b.name, 60) || fail('Nome do serviço obrigatório');
  return [name, str(b.description, 200), int(b.price_cents, 'Preço', 0, 10_000_00),
    int(b.duration_min, 'Duração', 5, 600), b.active === false || b.active === 0 ? 0 : 1, Number(b.sort) || 0];
}
route('POST', '/api/admin/services', ({ body }) => {
  const id = db.prepare('INSERT INTO services(name, description, price_cents, duration_min, active, sort) VALUES (?, ?, ?, ?, ?, ?)')
    .run(...serviceFields(body)).lastInsertRowid;
  return db.prepare('SELECT * FROM services WHERE id = ?').get(id);
}, { admin: true });
route('PUT', '/api/admin/services/:id', ({ params, body }) => {
  db.prepare('UPDATE services SET name = ?, description = ?, price_cents = ?, duration_min = ?, active = ?, sort = ? WHERE id = ?')
    .run(...serviceFields(body), Number(params.id));
  return db.prepare('SELECT * FROM services WHERE id = ?').get(Number(params.id)) || fail('Não encontrado', 404);
}, { admin: true });
route('DELETE', '/api/admin/services/:id', ({ params }) => {
  const id = Number(params.id);
  // com histórico de agendamentos: apenas desativa, para não perder relatórios
  if (db.prepare('SELECT 1 FROM appointments WHERE service_id = ? UNION SELECT 1 FROM waitlist WHERE service_id = ?').get(id, id)) {
    db.prepare('UPDATE services SET active = 0 WHERE id = ?').run(id);
    return { deactivated: true };
  }
  db.prepare('DELETE FROM services WHERE id = ?').run(id);
  return { deleted: true };
}, { admin: true });

// ----- admin: profissionais e expediente
function proWithHours(b) {
  const hours = db.prepare('SELECT * FROM working_hours WHERE pro_id = ? ORDER BY weekday').all(b.id).map(h => ({
    weekday: h.weekday, start: toHHMM(h.start_min), end: toHHMM(h.end_min),
    breakStart: h.break_start == null ? '' : toHHMM(h.break_start),
    breakEnd: h.break_end == null ? '' : toHHMM(h.break_end),
  }));
  return { ...b, hours };
}
function saveHours(proId, hours) {
  if (!Array.isArray(hours)) return;
  db.prepare('DELETE FROM working_hours WHERE pro_id = ?').run(proId);
  const ins = db.prepare('INSERT INTO working_hours VALUES (?, ?, ?, ?, ?, ?)');
  const DAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  for (const h of hours) {
    const wd = int(h.weekday, 'Dia da semana', 0, 6);
    const start = parseHHMM(h.start), end = parseHHMM(h.end);
    if (start == null || end == null || end <= start) fail(`Expediente inválido na ${DAYS[wd]}`);
    let bs = h.breakStart ? parseHHMM(h.breakStart) : null, be = h.breakEnd ? parseHHMM(h.breakEnd) : null;
    if ((bs == null) !== (be == null) || (bs != null && (be <= bs || bs < start || be > end))) {
      fail(`Intervalo inválido na ${DAYS[wd]}`);
    }
    ins.run(proId, wd, start, end, bs, be);
  }
}
function proWhatsapp(v) {
  const d = digits(v);
  if (d && (d.length < 10 || d.length > 13)) fail('WhatsApp da profissional inválido: use DDD + número');
  return d;
}
route('GET', '/api/admin/pros', () =>
  db.prepare('SELECT * FROM pros ORDER BY name').all().map(proWithHours), { admin: true });
/** Barra uma profissional ativa a mais do que o plano permite. */
function checkProLimit(salon, exceptId = null) {
  const max = maxProsFor(salon);
  if (max == null) return;
  const n = db.prepare('SELECT COUNT(*) n FROM pros WHERE active = 1 AND id != ?').get(exceptId ?? -1).n;
  if (n >= max) {
    fail(`O plano ${PLANS[salon.plan]?.name} permite até ${max} profissional${max > 1 ? 'is' : ''} ativa${max > 1 ? 's' : ''}. `
      + 'Mude de plano na aba Assinatura.', 403);
  }
}
route('POST', '/api/admin/pros', ({ body, salon }) => tx(() => {
  if (body.active !== false) checkProLimit(salon);
  const name = str(body.name, 60) || fail('Nome obrigatório');
  const id = Number(db.prepare('INSERT INTO pros(name, active, whatsapp) VALUES (?, ?, ?)')
    .run(name, body.active === false ? 0 : 1, proWhatsapp(body.whatsapp)).lastInsertRowid);
  saveHours(id, body.hours);
  return proWithHours(db.prepare('SELECT * FROM pros WHERE id = ?').get(id));
}), { admin: true });
route('PUT', '/api/admin/pros/:id', ({ params, body, salon }) => {
  const saved = tx(() => {
    const id = Number(params.id);
    const current = db.prepare('SELECT * FROM pros WHERE id = ?').get(id) || fail('Não encontrado', 404);
    if (body.active !== false && !current.active) checkProLimit(salon, id); // reativando
    const name = str(body.name, 60) || fail('Nome obrigatório');
    db.prepare('UPDATE pros SET name = ?, active = ?, whatsapp = ? WHERE id = ?')
      .run(name, body.active === false ? 0 : 1, proWhatsapp(body.whatsapp), id);
    saveHours(id, body.hours);
    return proWithHours(db.prepare('SELECT * FROM pros WHERE id = ?').get(id));
  });
  processWaitlist(); // expediente maior pode ter aberto vaga para quem esperava
  return saved;
}, { admin: true });
route('DELETE', '/api/admin/pros/:id', ({ params }) => {
  const id = Number(params.id);
  if (db.prepare('SELECT 1 FROM appointments WHERE pro_id = ?').get(id)) {
    db.prepare('UPDATE pros SET active = 0 WHERE id = ?').run(id);
    return { deactivated: true };
  }
  db.prepare('DELETE FROM pros WHERE id = ?').run(id);
  return { deleted: true };
}, { admin: true });

// ----- admin: bloqueios (folgas, feriados)
route('GET', '/api/admin/blocks', ({ query }) => {
  const from = isDate(query.get('from')) ? query.get('from') : localDate();
  return db.prepare(`SELECT k.*, b.name AS pro_name FROM blocks k LEFT JOIN pros b ON b.id = k.pro_id
                     WHERE k.date >= ? ORDER BY k.date, k.start_min`).all(from)
    .map(k => ({ ...k, start: toHHMM(k.start_min), end: toHHMM(k.end_min) }));
}, { admin: true });
route('POST', '/api/admin/blocks', ({ body }) => {
  const date = isDate(body.date) ? body.date : fail('Data inválida');
  const allDay = !!body.allDay;
  const start = allDay ? 0 : parseHHMM(body.start), end = allDay ? 1440 : parseHHMM(body.end);
  if (start == null || end == null || end <= start) fail('Horário do bloqueio inválido');
  const proId = body.proId ? Number(body.proId) : null;
  const id = db.prepare('INSERT INTO blocks(pro_id, date, start_min, end_min, reason) VALUES (?, ?, ?, ?, ?)')
    .run(proId, date, start, end, str(body.reason, 100)).lastInsertRowid;
  // avisa se já existem clientes marcados no período bloqueado
  const affected = db.prepare(`${APPT_SELECT} WHERE a.date = ? AND a.status = 'confirmed' AND a.start_min < ? AND a.end_min > ?
                               ${proId ? 'AND a.pro_id = ?' : ''}`)
    .all(...[date, end, start, ...(proId ? [proId] : [])]).map(apptView);
  return { id, affected };
}, { admin: true });
route('DELETE', '/api/admin/blocks/:id', ({ params }) => {
  db.prepare('DELETE FROM blocks WHERE id = ?').run(Number(params.id));
  processWaitlist();
  return { ok: true };
}, { admin: true });

// ----- admin: configurações
route('GET', '/api/admin/settings', () => {
  const s = getSettings();
  return Object.fromEntries(PUBLIC_SETTINGS.map(k => [k, s[k] ?? '']));
}, { admin: true });
route('PUT', '/api/admin/settings', ({ body, salon }) => {
  const numeric = { slot_step: [5, 120], min_advance_min: [0, 10080], max_days_ahead: [1, 365], cancel_advance_min: [0, 10080] };
  tx(() => {
    for (const k of PUBLIC_SETTINGS) {
      if (!(k in body)) continue;
      if (numeric[k]) setSetting(k, int(body[k], k, ...numeric[k]));
      else if (k === 'whatsapp') setSetting(k, digits(body[k]));
      else setSetting(k, str(body[k], k === 'about' ? 600 : 200));
    }
  });
  const name = getSettings().shop_name;
  if (name) platform.prepare('UPDATE salons SET name = ? WHERE id = ?').run(name, salon.id);
  return { ok: true };
}, { admin: true });

// ---------------------------------------------------------------- servidor
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json',
};

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readRaw(req) {
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 500_000) fail('Requisição muito grande', 413);
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function readBody(req) {
  const raw = await readRaw(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { fail('JSON inválido'); }
}

// Páginas com endereço "bonito". /s/<slug> é a página de agendamento de cada salão.
const PAGES = { '/': '/landing.html', '/cadastro': '/cadastro.html', '/entrar': '/entrar.html', '/painel': '/admin.html' };
async function serveStatic(pathname, res) {
  if (pathname === '/admin') { res.writeHead(301, { Location: '/painel' }).end(); return; }
  if (/^\/s\/[a-z0-9-]+\/?$/.test(pathname)) pathname = '/index.html';
  else if (/^\/c\/[\w-]+\/?$/.test(pathname)) pathname = '/confirmar.html';
  else pathname = PAGES[pathname.replace(/\/$/, '') || '/'] || pathname;
  const file = path.join(PUBLIC_DIR, path.normalize(decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end(); return; }
  try {
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Página não encontrada');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!url.pathname.startsWith('/api/')) return await serveStatic(url.pathname, res);

    // Eventos do Stripe: o corpo precisa chegar intacto para conferir a assinatura
    if (url.pathname === '/api/billing/webhook' && req.method === 'POST') {
      let event;
      try { event = verifyWebhook(await readRaw(req), req.headers['stripe-signature']); } catch (err) {
        if (err instanceof BillingError) fail(err.message, 400);
        throw err;
      }
      await handleWebhookEvent(event);
      return send(res, 200, { received: true });
    }

    // WhatsApp: validação do webhook (GET) e respostas das clientes (POST)
    if (url.pathname === '/api/whatsapp/webhook') {
      if (req.method === 'GET') {
        const challenge = verifyChallenge(url.searchParams);
        res.writeHead(challenge == null ? 403 : 200, { 'Content-Type': 'text/plain' }).end(challenge ?? 'Forbidden');
        return;
      }
      if (req.method === 'POST') {
        const raw = await readRaw(req);
        try { verifySignature(raw, req.headers['x-hub-signature-256']); } catch (err) { fail(err.message, 401); }
        let payload;
        try { payload = JSON.parse(raw); } catch { fail('JSON inválido'); }
        send(res, 200, { received: true }); // responde logo: a Meta reenvia se demorar
        for (const msg of parseInbound(payload)) {
          handleInbound(msg).catch(err => console.error('[whatsapp] resposta não processada:', err));
        }
        return;
      }
    }

    // /api/s/<slug>/info -> rota /api/info do salão <slug>
    let pathname = url.pathname, salon = null;
    const bySlug = /^\/api\/s\/([a-z0-9-]+)(\/.*)$/.exec(pathname);
    if (bySlug) {
      salon = platform.prepare('SELECT * FROM salons WHERE slug = ?').get(bySlug[1]) || fail('Estúdio não encontrado', 404);
      pathname = '/api' + bySlug[2];
    }

    let match = null, r = null;
    for (r of routes) {
      if (r.method === req.method && (match = r.re.exec(pathname))) break;
    }
    if (!match || (r.scope === 'salon') !== !!salon) fail('Rota não encontrada', 404);

    const ctx = { req, query: url.searchParams, salon, user: null };
    if (r.scope === 'admin') Object.assign(ctx, requireAdmin(req));
    ctx.params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
    ctx.body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};

    const result = ctx.salon
      ? await runAsSalon(ctx.salon.id, () => r.handler(ctx))
      : await r.handler(ctx);
    send(res, 200, result);
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    if (err instanceof BillingError) return send(res, 502, { error: err.message });
    console.error(err);
    send(res, 500, { error: 'Erro interno no servidor' });
  }
});

initReminders({ fail, cancelAppointment, getAppointment, getSalon, APPT_SELECT });
if (process.env.NAILS_SCHEDULER !== 'off') startReminderScheduler();

server.listen(PORT, () => {
  console.log(`\n  💅 nAIls rodando em http://localhost:${PORT}`);
  console.log(`  💳 Cobrança: ${BILLING_MODE === 'stripe' ? 'Stripe' : 'modo demonstração (sem STRIPE_SECRET_KEY)'}`);
  console.log(`  🤖 Agente de lembretes: ${whatsappEnabled ? 'envio automático pelo WhatsApp' : 'envio com um toque pelo painel'}`
    + ` · IA ${aiEnabled ? 'ligada' : 'desligada (mensagens padrão)'}\n`);
});
