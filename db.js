// Bancos de dados SQLite (embutido no Node.js, sem dependências externas)
//
// nAIls é multi-salão:
//   data/nails.db           -> plataforma: salões, contas, sessões e assinaturas
//   data/saloes/<id>.db     -> um banco por salão: serviços, profissionais, agenda, fila de espera...
//
// Cada salão em um arquivo separado deixa os dados de um salão fisicamente isolados dos outros.
// O código da agenda usa `db` sem saber de qual salão é: o salão da requisição atual fica num
// AsyncLocalStorage (runAsSalon), e `db` encaminha para o banco certo.
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const salonsDir = path.join(dataDir, 'saloes');
mkdirSync(salonsDir, { recursive: true });

// ================================================================ plataforma
export const platform = new DatabaseSync(path.join(dataDir, 'nails.db'));
platform.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS salons (
    id                     INTEGER PRIMARY KEY,
    slug                   TEXT NOT NULL UNIQUE,     -- endereço da página: /s/<slug>
    name                   TEXT NOT NULL,
    plan                   TEXT NOT NULL DEFAULT 'profissional',
    status                 TEXT NOT NULL DEFAULT 'trialing', -- trialing | active | past_due | canceled | incomplete
    trial_ends_at          TEXT,                     -- ISO (UTC)
    current_period_end     TEXT,                     -- ISO (UTC): fim do período pago atual
    stripe_customer_id     TEXT,
    stripe_subscription_id TEXT,
    created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    salon_id      INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Sessões de login do painel. Guarda só o hash do token: quem ler o banco não consegue entrar.
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL  -- ms desde 1970
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

// ================================================================ banco de cada salão
const TENANT_SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS services (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    price_cents  INTEGER NOT NULL,
    duration_min INTEGER NOT NULL,
    active       INTEGER NOT NULL DEFAULT 1,
    sort         INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS pros (
    id       INTEGER PRIMARY KEY,
    name     TEXT NOT NULL,
    active   INTEGER NOT NULL DEFAULT 1,
    whatsapp TEXT NOT NULL DEFAULT ''   -- recebe os avisos de cancelamento
  );

  -- Expediente semanal de cada profissional (weekday: 0=domingo ... 6=sábado; horários em minutos)
  CREATE TABLE IF NOT EXISTS working_hours (
    pro_id      INTEGER NOT NULL REFERENCES pros(id) ON DELETE CASCADE,
    weekday     INTEGER NOT NULL,
    start_min   INTEGER NOT NULL,
    end_min     INTEGER NOT NULL,
    break_start INTEGER,
    break_end   INTEGER,
    PRIMARY KEY (pro_id, weekday)
  );

  -- Bloqueios: folgas, feriados, compromissos (pro_id NULL = salão inteiro)
  CREATE TABLE IF NOT EXISTS blocks (
    id        INTEGER PRIMARY KEY,
    pro_id    INTEGER REFERENCES pros(id) ON DELETE CASCADE,
    date      TEXT NOT NULL,
    start_min INTEGER NOT NULL,
    end_min   INTEGER NOT NULL,
    reason    TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id             INTEGER PRIMARY KEY,
    code           TEXT NOT NULL UNIQUE,
    pro_id         INTEGER NOT NULL REFERENCES pros(id),
    service_id     INTEGER NOT NULL REFERENCES services(id),
    date           TEXT NOT NULL,
    start_min      INTEGER NOT NULL,
    end_min        INTEGER NOT NULL,
    customer_name  TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    notes          TEXT NOT NULL DEFAULT '',
    price_cents    INTEGER NOT NULL,
    status         TEXT NOT NULL DEFAULT 'confirmed',
    cancel_reason  TEXT NOT NULL DEFAULT '',   -- motivo informado ao cancelar
    cancelled_by   TEXT,                       -- 'cliente' | 'estudio'
    cancelled_at   TEXT,
    cancel_seen    INTEGER NOT NULL DEFAULT 1, -- 0 = cancelamento da cliente ainda não visto no painel
    created_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  -- Fila de espera: cliente aguardando um horário ocupado vagar.
  -- pro_id NULL = aceita qualquer profissional. Ao vagar, vira um agendamento com o mesmo código.
  CREATE TABLE IF NOT EXISTS waitlist (
    id             INTEGER PRIMARY KEY,
    code           TEXT NOT NULL UNIQUE,
    pro_id         INTEGER REFERENCES pros(id) ON DELETE CASCADE,
    service_id     INTEGER NOT NULL REFERENCES services(id),
    date           TEXT NOT NULL,
    start_min      INTEGER NOT NULL,
    customer_name  TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    notes          TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'waiting',  -- waiting | promoted | cancelled
    appointment_id INTEGER REFERENCES appointments(id),
    notified       INTEGER NOT NULL DEFAULT 0,       -- o salão já avisou a cliente que a vaga saiu?
    created_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_wait_date ON waitlist(date, start_min);
  CREATE INDEX IF NOT EXISTS idx_appt_date ON appointments(date, pro_id);
  CREATE INDEX IF NOT EXISTS idx_blocks_date ON blocks(date);
`;

const DEFAULT_SETTINGS = {
  shop_name: 'Meu estúdio',
  about: 'Esmaltação em gel, alongamento e nail art com acabamento impecável.',
  address: '',
  phone: '',
  whatsapp: '',
  instagram: '',
  slot_step: '15',           // intervalo entre horários oferecidos (min)
  min_advance_min: '60',     // antecedência mínima para a cliente agendar (min)
  max_days_ahead: '30',      // até quantos dias à frente a cliente pode agendar
  cancel_advance_min: '120', // antecedência mínima para a cliente cancelar online (min)
};

const DEFAULT_SERVICES = [
  ['Manicure', 'Cutilagem, lixamento e esmaltação', 3500, 30],
  ['Pedicure', 'Cutilagem, esfoliação e esmaltação', 4000, 30],
  ['Mão + Pé', 'Manicure e pedicure completas', 7000, 60],
  ['Nail art', 'Decoração em até 2 unhas: desenho, pedraria ou foil', 2000, 15],
  ['Spa das mãos', 'Esfoliação e hidratação profunda', 2500, 15],
  ['Esmaltação em gel', 'Brilho e duração de até 3 semanas', 8000, 60],
  ['Alongamento em gel', 'Unhas alongadas no molde F1, com esmaltação', 16000, 120],
];

const tenants = new Map(); // salonId -> DatabaseSync aberto

function openTenant(salonId) {
  const id = Number(salonId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Salão inválido');
  let t = tenants.get(id);
  if (!t) {
    t = new DatabaseSync(path.join(salonsDir, `${id}.db`));
    t.exec(TENANT_SCHEMA);
    tenants.set(id, t);
  }
  return t;
}

/**
 * Cria o banco de um salão novo com dados iniciais prontos para usar:
 * configurações, serviços de exemplo e a dona como primeira profissional (ter-sáb).
 */
export function initSalonDb(salonId, { shopName, ownerName, whatsapp = '' }) {
  const t = openTenant(salonId);
  if (t.prepare('SELECT COUNT(*) n FROM settings').get().n > 0) return;
  t.exec('BEGIN');
  try {
    const setS = t.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries({ ...DEFAULT_SETTINGS, shop_name: shopName, whatsapp })) setS.run(k, String(v));

    const insS = t.prepare('INSERT INTO services(name, description, price_cents, duration_min, sort) VALUES (?, ?, ?, ?, ?)');
    DEFAULT_SERVICES.forEach((s, i) => insS.run(...s, i));

    const proId = Number(t.prepare('INSERT INTO pros(name, whatsapp) VALUES (?, ?)').run(ownerName, whatsapp).lastInsertRowid);
    const insH = t.prepare('INSERT INTO working_hours VALUES (?, ?, ?, ?, ?, ?)');
    for (const wd of [2, 3, 4, 5]) insH.run(proId, wd, 9 * 60, 19 * 60, 12 * 60, 13 * 60); // ter-sex 09-19
    insH.run(proId, 6, 8 * 60, 17 * 60, 12 * 60, 13 * 60);                                  // sáb 08-17
    t.exec('COMMIT');
  } catch (err) {
    t.exec('ROLLBACK');
    throw err;
  }
}

// ---------------------------------------------------------------- salão da requisição atual
const context = new AsyncLocalStorage();

/** Executa `fn` com `db` apontando para o banco do salão. Funciona também com funções async. */
export const runAsSalon = (salonId, fn) => context.run({ salonId: Number(salonId), db: openTenant(salonId) }, fn);
export const currentSalonId = () => context.getStore()?.salonId ?? null;

/** Banco do salão atual. Usar fora de runAsSalon é um erro de programação. */
export const db = new Proxy({}, {
  get(_, prop) {
    const ctx = context.getStore();
    if (!ctx) throw new Error('Nenhum salão no contexto (use runAsSalon)');
    const v = ctx.db[prop];
    return typeof v === 'function' ? v.bind(ctx.db) : v;
  },
});

// ---------------------------------------------------------------- utilitários
export function hashPassword(pw) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(pw, salt, 64).toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const calc = scryptSync(String(pw), Buffer.from(salt, 'hex'), 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === calc.length && timingSafeEqual(expected, calc);
}

export function getSettings() {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]));
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

/** Transação no banco informado (padrão: o do salão atual). */
export function tx(fn, database = db) {
  database.exec('BEGIN');
  try {
    const result = fn();
    database.exec('COMMIT');
    return result;
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
}
