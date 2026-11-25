// Testa a IA dos agentes com dados de exemplo (não mexe em nenhum salão nem envia mensagens).
//   npm run testar-ia
// Faz 4 chamadas curtas ao Claude: escreve 1 lembrete e interpreta 3 respostas de clientes.
import { aiEnabled, writeReminder, interpretReply } from '../agents/ia.js';

if (!aiEnabled) {
  console.log('\n  IA desligada: coloque ANTHROPIC_API_KEY no arquivo .env (veja .env.example) e rode de novo.\n');
  process.exit(1);
}

const model = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
console.log(`\n  Testando a IA (${model})...\n`);

const facts = {
  kind: 'vespera', salao: 'Studio Exemplo Nails', cliente: 'Mariana', servico: 'Alongamento em gel',
  profissional: 'Camila', quando: 'amanhã, sexta-feira (27/11) às 10:00', endereco: 'Rua Augusta, 1500 - São Paulo',
};
const context = {
  salao: facts.salao, endereco: facts.endereco, telefone: '(11) 99999-0000', cliente: facts.cliente,
  servico: facts.servico, profissional: facts.profissional, quando: facts.quando, situacao_do_horario: 'marcado',
  servicos: ['Manicure: R$ 35,00, 30 min', 'Alongamento em gel: R$ 160,00, 120 min'],
};

let ok = true;
const step = async (label, fn) => {
  const t = Date.now();
  try {
    const out = await fn();
    console.log(`  ✓ ${label} (${((Date.now() - t) / 1000).toFixed(1)}s)\n${out}\n`);
  } catch (err) {
    ok = false;
    console.log(`  ✗ ${label}: ${err.message}\n`);
  }
};

await step('Lembrete da véspera', async () => `    "${await writeReminder(facts)}"`);
for (const [text, expected] of [
  ['Simmm, confirmo! 💅', 'confirm'],
  ['Oi, não vou conseguir ir amanhã, meu filho ficou doente', 'decline'],
  ['Qual o endereço mesmo? Tem estacionamento?', 'question'],
]) {
  await step(`Resposta: "${text}"`, async () => {
    const r = await interpretReply(context, text);
    if (r.intent !== expected) throw new Error(`entendeu "${r.intent}", esperado "${expected}"`);
    return `    intenção: ${r.intent}${r.reason ? ` · motivo: ${r.reason}` : ''}\n    resposta: "${r.reply}"`;
  });
}

console.log(ok ? '  IA funcionando. Reinicie o servidor (npm start) para os agentes usarem.\n' : '  Algo falhou: veja as mensagens acima.\n');
process.exit(ok ? 0 : 1);
