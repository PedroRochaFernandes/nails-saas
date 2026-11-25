// Painel do salão: agenda, serviços/preços, profissionais/expediente, bloqueios, configurações e assinatura
let token = null;
try { token = localStorage.getItem('nailsToken'); } catch {}
let services = [], pros = [], account = null;

const api = (method, url, body) => http(method, url, body, token).catch(err => {
  if (err.status === 401) showLogin();
  throw err;
});

// ------------------------------------------------------------- login (página /entrar)
function showLogin() {
  try { localStorage.removeItem('nailsToken'); } catch {}
  location.href = '/entrar';
}

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/admin/logout').catch(() => {});
  showLogin();
});

async function start() {
  try {
    [services, pros, account] = await Promise.all([
      api('GET', '/api/admin/services'), api('GET', '/api/admin/pros'), api('GET', '/api/admin/account')]);
  } catch { return; }
  $('#app-view').classList.remove('hidden');
  const s = await api('GET', '/api/admin/settings');
  $('#shop-name').textContent = s.shop_name;
  fillSettings(s);
  fillProSelects();
  renderAccount();
  if (!$('#agenda-date').value) $('#agenda-date').value = localDate();
  loadAgenda();
  renderServices();
  renderPros();
  loadBlocks();

  const params = new URLSearchParams(location.search);
  if (params.has('bemvinda')) toast('Conta criada! Seu teste grátis começou. Confira os serviços e o expediente.', 'ok');
  if (params.get('checkout')) syncCheckout(params.get('checkout'));
  if (params.has('bemvinda') || params.has('checkout')) history.replaceState(null, '', '/painel' + location.hash);
  if (location.hash === '#assinatura') openTab('assinatura');
  loadAgents();
}

// ------------------------------------------------------------- agentes de IA
const confBadge = a => a.status !== 'confirmed' ? ''
  : a.confirmation === 'confirmed' ? ' <span class="conf confirmed">✓ confirmou</span>'
  : a.confirmation === 'pending' ? ' <span class="conf pending">aguardando confirmação</span>' : '';

const KIND_LABEL = { vespera: 'Lembrete da véspera', '2h': 'Aviso 2h antes', vaga: 'Vaga da fila de espera' };
const EVENT_ICON = { confirmed: '✅', declined: '❌', reschedule: '🔁', question: '💬', failed: '⚠️' };
let agents = null;

async function loadAgents() {
  try { agents = await api('GET', '/api/admin/agentes'); } catch { return; }
  renderAgents();
}

function renderAgents() {
  const a = agents, el = $('#agent-reminders');
  if (!a.allowed) {
    el.innerHTML = `<h3>Lembretes e confirmações <span class="pill off">Indisponível no seu plano</span></h3>
      <p class="muted">O agente lembra as clientes na véspera e 2 horas antes, pede confirmação e libera o horário para a fila de espera se alguém desmarcar.
      Ele faz parte dos planos Profissional e Studio${account?.salon.online ? '' : ', com a assinatura em dia'}.</p>
      <button class="btn btn-primary btn-sm" data-goto="assinatura">Ver planos</button>`;
    el.querySelector('[data-goto]').addEventListener('click', () => openTab('assinatura'));
    return;
  }
  const s = a.settings, on = s.enabled || s.twoHours;
  const hours = Array.from({ length: 13 }, (_, i) => `${String(8 + i).padStart(2, '0')}:00`);
  const stat = (label, c) => `<div class="card"><span class="muted small">${label}</span><br>
    <b>${c.confirmed}</b> confirmaram · <b>${c.pending}</b> aguardando${c.none ? ` · <b>${c.none}</b> sem lembrete ainda` : ''}</div>`;
  const fmtTime = iso => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  el.innerHTML = `
    <h3>Lembretes e confirmações <span class="pill ${on ? 'on' : 'off'}">${on ? 'Ativo' : 'Desligado'}</span></h3>
    <div class="agent-meta">
      <span>Envio: <b>${a.channel === 'whatsapp' ? 'automático pelo WhatsApp' : 'com um toque'}</b>
        ${a.channel === 'whatsapp' ? '· as respostas das clientes são entendidas pelo agente' : '· o agente prepara as mensagens e você envia pelo seu WhatsApp'}</span>
      <span>Mensagens: <b>${a.ai ? 'escritas pela IA' : 'texto padrão'}</b> · cada cliente recebe um link para confirmar ou desmarcar</span>
    </div>
    <form class="agent-form" id="agent-form">
      <label class="check"><input type="checkbox" name="enabled" ${s.enabled ? 'checked' : ''}> Lembrete na véspera às</label>
      <div class="field"><select name="hour" aria-label="Horário do lembrete da véspera">${hours.map(h => `<option ${h === s.hour ? 'selected' : ''}>${h}</option>`).join('')}</select></div>
      <label class="check"><input type="checkbox" name="twoHours" ${s.twoHours ? 'checked' : ''}> Aviso 2 horas antes</label>
      <button class="btn btn-sm" type="button" id="agent-run" style="margin-left:auto">Verificar agora</button>
    </form>
    <div class="confirm-stats">${stat('Hoje', a.today)}${stat('Amanhã', a.tomorrow)}</div>

    <h3 style="margin-top:8px">Para enviar ${a.queue.length ? `<span class="tag">${a.queue.length}</span>` : ''}</h3>
    ${a.queue.length ? a.queue.map(q => `
      <div class="queue-item">
        <div><strong>${esc(q.customerName)}</strong> <span class="muted small">· ${KIND_LABEL[q.kind]} · ${esc(q.serviceName)}, ${fmtDate(q.date, { day: '2-digit', month: '2-digit' })} às ${q.start}${q.ai ? ' · escrita pela IA' : ''}</span>
          ${q.error ? `<div class="small cancel-why">Envio automático falhou: ${esc(q.error)}</div>` : ''}
          <pre>${esc(q.message)}</pre></div>
        <a class="btn btn-primary btn-sm" href="${q.url}" target="_blank" rel="noopener" data-sent="${q.id}">Enviar no WhatsApp</a>
      </div>`).join('') : `<p class="muted small">${a.channel === 'whatsapp' ? 'Os lembretes estão saindo sozinhos pelo WhatsApp.' : 'Nada para enviar agora. Os lembretes aparecem aqui na hora certa.'}</p>`}

    <h3 style="margin-top:24px">Atividade do agente</h3>
    ${a.events.length ? `<ul class="events">${a.events.map(e => `<li><time>${fmtTime(e.created_at)}</time><span>${EVENT_ICON[e.kind] || '•'} ${esc(e.detail)}</span></li>`).join('')}</ul>`
      : '<p class="muted small">Quando as clientes confirmarem, desmarcarem ou responderem, aparece aqui.</p>'}`;

  $('#agent-form').addEventListener('change', async ev => {
    const f = ev.currentTarget;
    try {
      agents.settings = await api('PUT', '/api/admin/agentes/lembretes', {
        enabled: f.enabled.checked, twoHours: f.twoHours.checked, hour: f.hour.value });
      toast('Agente atualizado', 'ok');
      renderAgents();
    } catch (e) { toast(e.message, 'error'); }
  });
  $('#agent-run').addEventListener('click', async ev => {
    ev.target.disabled = true;
    try {
      agents = await api('POST', '/api/admin/agentes/rodar');
      toast(agents.created ? `${agents.created} lembrete(s) criado(s)` : 'Nenhum lembrete devido agora', 'ok');
      renderAgents();
      loadAgenda();
    } catch (e) { toast(e.message, 'error'); ev.target.disabled = false; }
  });
  $$('[data-sent]').forEach(b => b.addEventListener('click', () => {
    // abriu o WhatsApp com a mensagem pronta: tira da lista
    api('POST', `/api/admin/agentes/lembretes/${b.dataset.sent}/enviado`).then(loadAgents).catch(() => {});
  }));
}

// a lista de lembretes muda com o tempo: atualiza ao abrir a aba
$('[data-tab="agentes"]').addEventListener('click', loadAgents);

// ------------------------------------------------------------- abas
function openTab(name) {
  $$('.tab').forEach(x => x.setAttribute('aria-selected', x.dataset.tab === name));
  $$('.panel').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== name));
}
$$('.tab').forEach(t => t.addEventListener('click', () => openTab(t.dataset.tab)));

// ------------------------------------------------------------- conta e assinatura
const pageUrl = () => `${location.origin}/s/${account.salon.slug}`;
const fmtDay = iso => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function renderAccount() {
  const { salon, plans, billingMode } = account;
  $('#page-link').href = $('#my-page').href = pageUrl();
  $('#page-link').textContent = pageUrl().replace(/^https?:\/\//, '');

  // aviso no topo do painel
  let banner = '';
  if (!salon.online) {
    banner = `<div class="banner warn"><span><strong>Sua agenda online está pausada</strong> (${esc(salon.statusLabel.toLowerCase())}). As clientes veem a página, mas não conseguem agendar.</span>
      <button class="btn btn-primary btn-sm" data-goto="assinatura">Escolher um plano</button></div>`;
  } else if (salon.status === 'trialing') {
    banner = `<div class="banner info"><span>Teste grátis: <strong>${plural(salon.trialDaysLeft, 'dia')}</strong> até ${fmtDay(salon.trialEndsAt)}.</span>
      <button class="btn btn-sm" data-goto="assinatura">Ver planos</button></div>`;
  } else if (salon.status === 'past_due') {
    banner = `<div class="banner warn"><span><strong>Não conseguimos cobrar sua assinatura.</strong> Atualize a forma de pagamento para não pausar a agenda.</span>
      <button class="btn btn-sm" data-goto="assinatura">Resolver</button></div>`;
  }
  $('#account-banner').innerHTML = banner;
  $$('[data-goto]').forEach(b => b.addEventListener('click', () => openTab(b.dataset.goto)));

  // situação atual
  const paid = ['active', 'past_due'].includes(salon.status);
  let detail = '';
  if (salon.status === 'trialing' && salon.online) detail = `Teste grátis até ${fmtDay(salon.trialEndsAt)}, com os recursos do plano ${esc(salon.planName)}.`;
  else if (paid && salon.currentPeriodEnd) detail = `Renova em ${fmtDay(salon.currentPeriodEnd)}.`;
  else if (!salon.online) detail = 'Escolha um plano para reativar a agenda online.';
  $('#sub-status').innerHTML = `
    <div><span class="muted small">Plano ${esc(salon.planName)} · ${esc(salon.statusLabel)}</span><br>
      <b>${paid ? `${money(plans[salon.plan].priceCents)}/mês` : esc(salon.statusLabel)}</b>
      <p class="muted small" style="margin:4px 0 0">${detail}</p></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${salon.hasBilling ? '<button class="btn btn-sm" id="portal">Pagamento e faturas</button>' : ''}
      ${billingMode === 'demo' && paid ? '<button class="btn btn-sm btn-danger" id="demo-cancel">Cancelar (demonstração)</button>' : ''}
    </div>`;

  $('#plans').innerHTML = Object.entries(plans).map(([key, p]) => {
    const current = key === salon.plan && paid;
    const label = current ? 'Plano atual' : paid ? `Mudar para ${p.name}` : `Assinar ${p.name}`;
    return `<div class="card plan ${current ? 'current' : ''}">
      <div><strong>${esc(p.name)}</strong> ${p.highlight ? '<span class="tag">Mais escolhido</span>' : ''}<br><span class="muted small">${esc(p.pitch)}</span></div>
      <div class="price">${money(p.priceCents)} <small>/mês</small></div>
      <ul>${p.features.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
      <button class="btn ${current ? '' : 'btn-primary'}" data-plan="${key}" ${current ? 'disabled' : ''}>${label}</button>
    </div>`;
  }).join('');
  $$('[data-plan]').forEach(b => b.addEventListener('click', () => checkout(b.dataset.plan, b)));
  $('#billing-note').textContent = billingMode === 'demo'
    ? 'Modo demonstração: nenhum pagamento é cobrado. Configure STRIPE_SECRET_KEY no servidor para cobrar de verdade.'
    : 'Pagamento seguro pelo Stripe. Troque o cartão, veja faturas ou cancele em "Pagamento e faturas".';

  $('#portal')?.addEventListener('click', async ev => {
    ev.target.disabled = true;
    try { location.href = (await api('POST', '/api/admin/billing/portal')).url; } catch (e) { toast(e.message, 'error'); ev.target.disabled = false; }
  });
  $('#demo-cancel')?.addEventListener('click', async () => {
    if (!confirm('Cancelar a assinatura? A agenda online fica pausada.')) return;
    await api('POST', '/api/admin/billing/cancel').catch(e => toast(e.message, 'error'));
    refreshAccount();
  });
}

async function refreshAccount() {
  account = await api('GET', '/api/admin/account');
  renderAccount();
}

async function checkout(plan, btn) {
  btn.disabled = true;
  try {
    const r = await api('POST', '/api/admin/billing/checkout', { plan });
    if (r.url) { location.href = r.url; return; }
    toast(r.demo ? 'Plano ativado (modo demonstração).' : 'Plano alterado.', 'ok');
    await refreshAccount();
  } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
}

/** Voltou do pagamento no Stripe: confirma e atualiza a situação. */
async function syncCheckout(sessionId) {
  openTab('assinatura');
  try {
    account = await api('POST', '/api/admin/billing/sync', { sessionId });
    renderAccount();
    toast(account.salon.online ? 'Assinatura ativa. Obrigado!' : 'Pagamento em processamento. Atualize em instantes.', 'ok');
  } catch (e) { toast(e.message, 'error'); }
}

$('#copy-link').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(pageUrl()); toast('Link copiado. Coloque na bio do Instagram!', 'ok'); }
  catch { toast(pageUrl()); }
});


function fillProSelects() {
  const opts = pros.filter(b => b.active).map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
  $('#agenda-pro').innerHTML = `<option value="">Todas as profissionais</option>${opts}`;
  $('#b-pro').innerHTML = `<option value="">Todo o estúdio</option>${opts}`;
  $('#m-pro').innerHTML = `<option value="">Qualquer um livre</option>${opts}`;
  $('#m-service').innerHTML = services.filter(s => s.active)
    .map(s => `<option value="${s.id}">${esc(s.name)} — ${money(s.price_cents)} (${fmtDuration(s.duration_min)})</option>`).join('');
}

// ------------------------------------------------------------- agenda
async function loadAgenda() {
  const date = $('#agenda-date').value;
  const proId = Number($('#agenda-pro').value) || null;
  let list = await api('GET', `/api/admin/appointments?from=${date}&to=${date}`);
  if (proId) list = list.filter(a => a.proId === proId);

  $('#agenda-title').textContent = fmtDate(date);
  const active = list.filter(a => a.status !== 'cancelled');
  const revenue = active.filter(a => a.status !== 'no_show').reduce((t, a) => t + a.priceCents, 0);
  const done = list.filter(a => a.status === 'completed');
  $('#stats').innerHTML = `
    <div class="card stat"><span class="muted small">Agendamentos</span><b>${active.length}</b></div>
    <div class="card stat"><span class="muted small">Atendidos</span><b>${done.length}</b></div>
    <div class="card stat"><span class="muted small">Faturamento previsto</span><b>${money(revenue)}</b></div>
    <div class="card stat"><span class="muted small">Já faturado</span><b>${money(done.reduce((t, a) => t + a.priceCents, 0))}</b></div>`;

  $('#agenda-list').innerHTML = list.length ? list.map(a => `
    <div class="appt ${a.status}">
      <div class="time">${a.start}<div class="muted small" style="font-weight:400">${a.end}</div></div>
      <div>
        <strong>${esc(a.customerName)}</strong>${a.fromWaitlist ? ' <span class="tag">veio da fila de espera</span>' : ''}${confBadge(a)}
        <a class="small" href="https://wa.me/${waNumber(a.customerPhone)}" target="_blank" rel="noopener">${fmtPhone(a.customerPhone)}</a><br>
        <span class="muted small">${esc(a.serviceName)} · ${esc(a.proName)} · ${money(a.priceCents)} · cód. ${a.code}</span>
        ${a.notes ? `<div class="small muted" style="margin-top:4px">Obs.: ${esc(a.notes)}</div>` : ''}
        ${a.status === 'cancelled' && a.cancelledBy ? `<div class="small cancel-why">Cancelado ${a.cancelledBy === 'cliente' ? 'pela cliente' : 'pelo estúdio'}${a.cancelReason ? ` · Motivo: ${esc(a.cancelReason)}` : ''}</div>` : ''}
      </div>
      <div class="appt-actions">
        ${a.status === 'confirmed' ? `<button class="btn btn-sm btn-danger" data-cancel="${a.id}">Cancelar</button>` : ''}
        <select data-status="${a.id}" aria-label="Status">
          ${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${k === a.status ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
      </div>
    </div>`).join('') : '<div class="empty" style="border:0">Nenhum agendamento neste dia.</div>';

  const byId = Object.fromEntries(list.map(a => [a.id, a]));
  $$('[data-cancel]').forEach(b => b.addEventListener('click', () => openCancel(byId[b.dataset.cancel])));
  $$('[data-status]').forEach(sel => sel.addEventListener('change', async () => {
    const a = byId[sel.dataset.status];
    if (sel.value === 'cancelled') { // cancelar sempre passa pela janela do motivo
      sel.value = a.status;
      return openCancel(a);
    }
    try {
      await api('PATCH', `/api/admin/appointments/${a.id}`, { status: sel.value });
      toast('Status atualizado', 'ok');
    } catch (e) { toast(e.message, 'error'); }
    loadAgenda();
  }));

  loadWaitlist();
}

// ----- cancelar pelo estúdio: motivo (opcional) e mensagem pronta para o cliente
let cancelling = null;
function openCancel(a) {
  cancelling = a;
  $('#cx-info').textContent = `${a.customerName} · ${fmtDate(a.date)} às ${a.start} · ${a.serviceName} com ${a.proName}`;
  $('#cx-reason').value = '';
  $('#cancel-form').classList.remove('hidden');
  $('#cancel-done').classList.add('hidden');
  $('#cancel-modal').classList.remove('hidden');
  $('#cx-reason').focus();
}
function closeCancel() {
  $('#cancel-modal').classList.add('hidden');
  cancelling = null;
}
$('#cx-back').addEventListener('click', closeCancel);
$('#cx-close').addEventListener('click', closeCancel);
$('#cancel-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  const btn = $('#cx-confirm');
  btn.disabled = true;
  try {
    const r = await api('PATCH', `/api/admin/appointments/${cancelling.id}`, { status: 'cancelled', reason: $('#cx-reason').value });
    $('#cancel-form').classList.add('hidden');
    $('#cancel-done').classList.remove('hidden');
    $('#cx-done-text').textContent = r.filaOcupou
      ? `O horário já foi passado para ${r.filaOcupou}, que estava na fila de espera. Agora avise ${firstName(r.customerName)}:`
      : `Agora avise ${firstName(r.customerName)}. O WhatsApp abre com a mensagem pronta:`;
    $('#cx-preview').textContent = r.notify.texto;
    $('#cx-whats').href = r.notify.url;
    $('#cx-whats').textContent = `Avisar ${firstName(r.customerName)} no WhatsApp`;
    loadAgenda();
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; }
});

// ----- fila de espera
async function loadWaitlist() {
  const date = $('#agenda-date').value;
  const proId = Number($('#agenda-pro').value) || null;
  const { waiting, toNotify, cancellations } = await api('GET', '/api/admin/waitlist');

  // Clientes que cancelaram pelo site (aparece mesmo que o cliente não tenha mandado o WhatsApp)
  const cancelAlerts = cancellations.map(a => `<div class="alert alert-cancel">
      <div><strong>${esc(a.customerName)} cancelou</strong> <span class="tag tag-cancel">cancelado pela cliente</span><br>
        <span class="muted small">${esc(fmtDate(a.date))} às ${a.start} · ${esc(a.serviceName)} com ${esc(a.proName)}</span><br>
        <span class="small">Motivo: ${esc(a.cancelReason)}</span></div>
      <button class="btn btn-sm" data-seen="${a.id}">Ok, visto</button>
    </div>`).join('');

  // Quem ganhou um horário que vagou já está na agenda; falta o dono avisar (um clique no WhatsApp)
  $('#waitlist-alerts').innerHTML = cancelAlerts + toNotify.map(a => {
    const msg = `Olá, ${a.customerName}! Boa notícia: o horário das ${a.start} de ${fmtDate(a.date)} vagou e seu agendamento ` +
      `(${a.serviceName} com ${a.proName}) está confirmado na ${$('#shop-name').textContent}. Código: ${a.code}. ` +
      'Se não puder vir, é só cancelar pelo site ou responder esta mensagem.';
    return `<div class="alert">
      <div><strong>Vaga liberada para ${esc(a.customerName)}</strong> <span class="tag">fila de espera</span><br>
        <span class="muted small">${esc(fmtDate(a.date))} às ${a.start} · ${esc(a.serviceName)} com ${esc(a.proName)} · já está na agenda. Avise a cliente.</span></div>
      <a class="btn btn-primary btn-sm" data-notify="${a.waitId}" target="_blank" rel="noopener"
         href="https://wa.me/${waNumber(a.customerPhone)}?text=${encodeURIComponent(msg)}">Avisar no WhatsApp</a>
      <button class="btn btn-sm" data-notify="${a.waitId}">Já avisei</button>
    </div>`;
  }).join('');
  $$('[data-notify]').forEach(el => el.addEventListener('click', async () => {
    await api('POST', `/api/admin/waitlist/${el.dataset.notify}/notified`).catch(() => {});
    loadWaitlist();
  }));
  $$('[data-seen]').forEach(el => el.addEventListener('click', async () => {
    await api('POST', `/api/admin/appointments/${el.dataset.seen}/seen`).catch(() => {});
    loadWaitlist();
  }));

  // Quem ainda está aguardando no dia selecionado
  const day = waiting.filter(w => w.date === date && (!proId || !w.proId || w.proId === proId));
  const others = waiting.length - waiting.filter(w => w.date === date).length;
  $('#waitlist-day').innerHTML = (day.length ? day.map(w => `
    <div class="appt">
      <div class="time">${w.start}<div class="muted small" style="font-weight:400">${w.position}º da fila</div></div>
      <div>
        <strong>${esc(w.customerName)}</strong>
        <a class="small" href="https://wa.me/${waNumber(w.customerPhone)}" target="_blank" rel="noopener">${fmtPhone(w.customerPhone)}</a><br>
        <span class="muted small">${esc(w.serviceName)} · ${w.proName ? 'com ' + esc(w.proName) : 'qualquer profissional'} · cód. ${w.code}</span>
        ${w.notes ? `<div class="small muted" style="margin-top:4px">Obs.: ${esc(w.notes)}</div>` : ''}
      </div>
      <button class="btn btn-sm btn-danger" data-unwait="${w.id}">Remover</button>
    </div>`).join('') : '<div class="empty" style="border:0">Ninguém na fila de espera neste dia.</div>') +
    (others ? `<div class="muted small" style="padding:10px 16px;border-top:1px solid var(--border)">+ ${others} na fila em outros dias.</div>` : '');
  $$('[data-unwait]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Remover este cliente da fila de espera?')) return;
    await api('DELETE', `/api/admin/waitlist/${b.dataset.unwait}`);
    loadWaitlist();
  }));
}

const shiftDay = n => { $('#agenda-date').value = addDays($('#agenda-date').value || localDate(), n); loadAgenda(); };
$('#day-prev').addEventListener('click', () => shiftDay(-1));
$('#day-next').addEventListener('click', () => shiftDay(1));
$('#day-today').addEventListener('click', () => { $('#agenda-date').value = localDate(); loadAgenda(); });
$('#agenda-date').addEventListener('change', loadAgenda);
$('#agenda-pro').addEventListener('change', loadAgenda);

// ----- novo agendamento manual
maskPhone($('#m-phone'));
$('#new-appt').addEventListener('click', () => {
  $('#appt-form').reset();
  $('#m-date').value = $('#agenda-date').value || localDate();
  $('#appt-modal').classList.remove('hidden');
  loadModalSlots();
});
$('#m-cancel').addEventListener('click', () => $('#appt-modal').classList.add('hidden'));
['#m-service', '#m-pro', '#m-date'].forEach(s => $(s).addEventListener('change', loadModalSlots));

async function loadModalSlots() {
  const sel = $('#m-time');
  sel.innerHTML = '<option value="">Carregando…</option>';
  const params = new URLSearchParams({ date: $('#m-date').value, serviceId: $('#m-service').value, proId: $('#m-pro').value });
  try {
    const slots = (await api('GET', `/api/admin/availability?${params}`)).slots.filter(s => s.available);
    sel.innerHTML = slots.length
      ? slots.map(s => `<option value="${s.time}">${s.time}</option>`).join('')
      : '<option value="">Sem horários livres</option>';
  } catch (e) { sel.innerHTML = `<option value="">${esc(e.message)}</option>`; }
}

$('#appt-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  try {
    const a = await api('POST', '/api/admin/appointments', {
      serviceId: $('#m-service').value, proId: $('#m-pro').value || null, date: $('#m-date').value,
      time: $('#m-time').value, name: $('#m-name').value, phone: $('#m-phone').value, notes: $('#m-notes').value,
    });
    toast(`Agendado com ${a.proName} às ${a.start}`, 'ok');
    $('#appt-modal').classList.add('hidden');
    $('#agenda-date').value = a.date;
    loadAgenda();
  } catch (e) { toast(e.message, 'error'); loadModalSlots(); }
});

// ------------------------------------------------------------- serviços
function renderServices() {
  $('#services-table tbody').innerHTML = services.map(s => serviceRow(s)).join('');
}
function serviceRow(s) {
  return `<tr data-id="${s.id ?? ''}">
    <td><input name="name" value="${esc(s.name)}" placeholder="Ex.: Manicure" required></td>
    <td><input name="description" value="${esc(s.description)}" placeholder="Detalhes"></td>
    <td><input name="price" type="number" min="0" step="0.01" value="${(s.price_cents / 100).toFixed(2)}"></td>
    <td><input name="duration_min" type="number" min="5" step="5" value="${s.duration_min}"></td>
    <td><input name="active" type="checkbox" ${s.active ? 'checked' : ''}></td>
    <td style="white-space:nowrap">
      <button class="btn btn-sm btn-primary" data-save>Salvar</button>
      <button class="btn btn-sm btn-danger" data-del aria-label="Excluir">✕</button>
    </td></tr>`;
}
$('#add-service').addEventListener('click', () => {
  $('#services-table tbody').insertAdjacentHTML('beforeend', serviceRow({ name: '', description: '', price_cents: 0, duration_min: 30, active: 1 }));
  $('#services-table tbody tr:last-child input').focus();
});
$('#services-table').addEventListener('click', async ev => {
  const tr = ev.target.closest('tr');
  if (!tr) return;
  const id = tr.dataset.id;
  const val = n => tr.querySelector(`[name="${n}"]`);
  if (ev.target.matches('[data-save]')) {
    const body = {
      name: val('name').value, description: val('description').value,
      price_cents: Math.round(Number(val('price').value) * 100), duration_min: Number(val('duration_min').value),
      active: val('active').checked, sort: id ? services.find(s => s.id == id)?.sort : services.length,
    };
    try {
      await api(id ? 'PUT' : 'POST', `/api/admin/services${id ? '/' + id : ''}`, body);
      toast('Serviço salvo', 'ok');
      await refreshServices();
    } catch (e) { toast(e.message, 'error'); }
  }
  if (ev.target.matches('[data-del]')) {
    if (!id) { tr.remove(); return; }
    if (!confirm('Excluir este serviço?')) return;
    const r = await api('DELETE', `/api/admin/services/${id}`);
    toast(r.deactivated ? 'Serviço tem histórico: foi desativado' : 'Serviço excluído', 'ok');
    await refreshServices();
  }
});
async function refreshServices() {
  services = await api('GET', '/api/admin/services');
  renderServices();
  fillProSelects();
}

// ------------------------------------------------------------- profissionais
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
function renderPros() {
  $('#pros-list').innerHTML = pros.map(b => proCard(b)).join('') ||
    '<div class="empty">Nenhuma profissional cadastrada.</div>';
}
function proCard(b) {
  const hours = Object.fromEntries((b.hours || []).map(h => [h.weekday, h]));
  return `<form class="card pro-card" data-id="${b.id ?? ''}">
    <header>
      <div class="field"><label>Nome</label><input name="name" value="${esc(b.name)}" required></div>
      <div class="field"><label>WhatsApp (recebe os cancelamentos)</label><input name="whatsapp" value="${esc(b.whatsapp ? fmtPhone(b.whatsapp) : '')}" inputmode="tel" placeholder="(11) 91234-5678"></div>
      <label class="check"><input type="checkbox" name="active" ${b.active ? 'checked' : ''}> Ativo (aparece no site)</label>
    </header>
    <p class="muted small" style="margin:-4px 0 12px">Quando uma cliente desta profissional cancelar, o aviso vai para este número. Sem número, vai para o WhatsApp do estúdio. A cliente vê o número ao enviar a mensagem.</p>
    <div class="scroll-x"><table class="grid">
      <thead><tr><th>Dia</th><th>Trabalha</th><th>Início</th><th>Fim</th><th>Intervalo de</th><th>até</th></tr></thead>
      <tbody>${DAY_ORDER.map(wd => {
        const h = hours[wd];
        return `<tr data-wd="${wd}">
          <td>${WEEKDAYS[wd]}</td>
          <td><input type="checkbox" name="on" ${h ? 'checked' : ''}></td>
          <td><input type="time" name="start" value="${h?.start || '09:00'}"></td>
          <td><input type="time" name="end" value="${h?.end || '19:00'}"></td>
          <td><input type="time" name="breakStart" value="${h ? h.breakStart : '12:00'}"></td>
          <td><input type="time" name="breakEnd" value="${h ? h.breakEnd : '13:00'}"></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
    <div style="display:flex;gap:10px;margin-top:12px">
      <button class="btn btn-primary btn-sm">Salvar</button>
      <button type="button" class="btn btn-danger btn-sm" data-del>Excluir</button>
    </div>
  </form>`;
}
$('#add-pro').addEventListener('click', () => {
  $('#pros-list .empty')?.remove();
  $('#pros-list').insertAdjacentHTML('beforeend', proCard({ name: '', active: 1, hours: [] }));
  $('#pros-list form:last-child input[name="name"]').focus();
});
$('#pros-list').addEventListener('submit', async ev => {
  ev.preventDefault();
  const form = ev.target, id = form.dataset.id;
  const hours = $$('tbody tr', form).filter(tr => $('[name="on"]', tr).checked).map(tr => ({
    weekday: Number(tr.dataset.wd), start: $('[name="start"]', tr).value, end: $('[name="end"]', tr).value,
    breakStart: $('[name="breakStart"]', tr).value, breakEnd: $('[name="breakEnd"]', tr).value,
  }));
  try {
    await api(id ? 'PUT' : 'POST', `/api/admin/pros${id ? '/' + id : ''}`,
      { name: form.elements.name.value, whatsapp: form.elements.whatsapp.value, active: form.elements.active.checked, hours });
    toast('Profissional salva', 'ok');
    await refreshPros();
  } catch (e) { toast(e.message, 'error'); }
});
$('#pros-list').addEventListener('click', async ev => {
  if (!ev.target.matches('[data-del]')) return;
  const form = ev.target.closest('form'), id = form.dataset.id;
  if (!id) { form.remove(); return; }
  if (!confirm('Excluir esta profissional?')) return;
  const r = await api('DELETE', `/api/admin/pros/${id}`);
  toast(r.deactivated ? 'Profissional tem histórico: foi desativada' : 'Profissional excluída', 'ok');
  await refreshPros();
});
async function refreshPros() {
  pros = await api('GET', '/api/admin/pros');
  renderPros();
  fillProSelects();
  loadAgenda();
}

// ------------------------------------------------------------- bloqueios
$('#b-allday').addEventListener('change', e => {
  $('#b-start').disabled = $('#b-end').disabled = e.target.checked;
});
$('#block-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  try {
    const r = await api('POST', '/api/admin/blocks', {
      date: $('#b-date').value, proId: $('#b-pro').value || null, allDay: $('#b-allday').checked,
      start: $('#b-start').value, end: $('#b-end').value, reason: $('#b-reason').value,
    });
    if (r.affected.length) {
      alert(`Atenção: ${r.affected.length} cliente(s) já marcado(s) nesse período:\n\n` +
        r.affected.map(a => `${a.start} — ${a.customerName} (${fmtPhone(a.customerPhone)}) com ${a.proName}`).join('\n') +
        '\n\nAvise-os e cancele/remarque pela Agenda.');
    } else toast('Bloqueio adicionado', 'ok');
    $('#block-form').reset();
    $('#b-start').disabled = $('#b-end').disabled = false;
    loadBlocks();
  } catch (e) { toast(e.message, 'error'); }
});
async function loadBlocks() {
  const list = await api('GET', '/api/admin/blocks');
  $('#blocks-list').innerHTML = list.length ? list.map(k => `
    <div class="appt" style="grid-template-columns:1fr auto">
      <div><strong>${esc(fmtDate(k.date, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }))}</strong>
        · ${k.start_min === 0 && k.end_min === 1440 ? 'Dia inteiro' : `${k.start}–${k.end}`}<br>
        <span class="muted small">${esc(k.pro_name || 'Todo o estúdio')}${k.reason ? ' · ' + esc(k.reason) : ''}</span></div>
      <button class="btn btn-sm btn-danger" data-block="${k.id}">Remover</button>
    </div>`).join('') : '<div class="empty" style="border:0">Nenhum bloqueio futuro.</div>';
  $$('[data-block]').forEach(b => b.addEventListener('click', async () => {
    await api('DELETE', `/api/admin/blocks/${b.dataset.block}`);
    loadBlocks();
    loadAgenda(); // remover um bloqueio pode liberar vaga para alguém da fila de espera
  }));
}

// ------------------------------------------------------------- configurações
function fillSettings(s) {
  for (const [k, v] of Object.entries(s)) {
    const el = $(`#settings-form [name="${k}"]`);
    if (el) el.value = v;
  }
}
$('#settings-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  const body = Object.fromEntries(new FormData(ev.target));
  try {
    await api('PUT', '/api/admin/settings', body);
    $('#shop-name').textContent = body.shop_name;
    toast('Configurações salvas', 'ok');
  } catch (e) { toast(e.message, 'error'); }
});
$('#password-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  try {
    await api('POST', '/api/admin/password', { current: $('#p-current').value, next: $('#p-next').value });
    ev.target.reset();
    toast('Senha alterada', 'ok');
  } catch (e) { toast(e.message, 'error'); }
});

if (token) start(); else showLogin();
