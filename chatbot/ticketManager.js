import { pool } from '../services/db.js';

export async function distribuirTicket(userId, queueName) {
  // 1. Buscar configuração
  let modoDistribuicao = 'manual';
  try {
    const res = await pool.query(`SELECT value FROM settings WHERE key = 'distribuicao_tickets' LIMIT 1`);
    modoDistribuicao = res.rows?.[0]?.value || 'manual';
  } catch (err) {
    console.error('❌ Erro ao buscar configuração de distribuição:', err);
  }

  if (modoDistribuicao === 'manual') {
    console.log('[📥 Manual] Aguardando agente puxar o ticket.');
    return;
  }

  // 2. Buscar fila do cliente
  let filaCliente = queueName;
  try {
    const res = await pool.query(`SELECT fila FROM clientes WHERE user_id = $1 LIMIT 1`, [userId]);
    const cliente = res.rows[0];
    if (!filaCliente) {
      filaCliente = cliente?.fila || 'Default';
      console.warn('⚠️ Cliente não tem fila definida, usando fila Default.');
    }
  } catch (err) {
    console.error('❌ Erro ao buscar fila do cliente:', err);
    filaCliente = 'Default';
  }

  // 3. Verifica se já existe ticket aberto
  let ticketAberto = null;
  try {
    const res = await pool.query(
      `SELECT * FROM tickets WHERE user_id = $1 AND status = 'open' LIMIT 1`,
      [userId]
    );
    ticketAberto = res.rows[0] || null;
  } catch (err) {
    console.error('❌ Erro ao buscar ticket aberto:', err);
  }

  if (ticketAberto) return;

  // 4. Buscar atendentes online dessa fila
  let candidatos = [];
  try {
    const res = await pool.query(`SELECT id, filas FROM atendentes WHERE status = 'online'`);
    candidatos = res.rows.filter(a => Array.isArray(a.filas) && a.filas.includes(filaCliente));
  } catch (err) {
    console.error('❌ Erro ao buscar atendentes online:', err);
  }

  if (!candidatos.length) {
    console.warn(`⚠️ Nenhum atendente online para a fila: "${filaCliente}". Criando ticket sem atendente.`);

    try {
      const res = await pool.query(`SELECT create_ticket($1, $2, $3) AS numero`, [
        userId,
        filaCliente,
        null,
      ]);
      const numero = res.rows[0]?.numero;
      console.log(`[✅ Criado] Ticket SEM atendente para fila "${filaCliente}", número: ${numero}`);
    } catch (err) {
      console.error('❌ Erro ao criar ticket via função (sem atendente):', err);
    }

    return;
  }

  // 5. Buscar contagem de tickets por atendente
  let cargas = [];
  try {
    const res = await pool.query(`SELECT * FROM contar_tickets_ativos_por_atendente()`);
    cargas = res.rows;
  } catch (err) {
    console.error('❌ Erro ao contar tickets por atendente:', err);
    return;
  }

  const mapaCargas = {};
  for (const linha of cargas) {
    mapaCargas[linha.assigned_to] = linha.total_tickets;
  }

  // 6. Escolher atendente com menos carga
  candidatos.sort((a, b) => {
    const cargaA = mapaCargas[a.id] || 0;
    const cargaB = mapaCargas[b.id] || 0;
    return cargaA - cargaB;
  });

  const escolhido = candidatos[0]?.id;
  if (!escolhido) {
    console.warn('⚠️ Não foi possível determinar atendente.');
    return;
  }

  // 7. Atribuir ou criar ticket
  if (ticketAberto) {
    try {
      await pool.query(`UPDATE tickets SET assigned_to = $1 WHERE id = $2`, [escolhido, ticketAberto.id]);
      console.log(`[✅ Atualizado] Ticket atribuído a ${escolhido}`);
    } catch (err) {
      console.error('❌ Erro ao atualizar ticket existente:', err);
    }
  } else {
    try {
      const res = await pool.query(`SELECT create_ticket($1, $2, $3) AS numero`, [
        userId,
        filaCliente,
        escolhido,
      ]);
      const numero = res.rows[0]?.numero;
      console.log(`[✅ Criado] Novo ticket atribuído a ${escolhido}, número: ${numero}`);
    } catch (err) {
      console.error('❌ Erro ao criar ticket via função:', err);
    }
  }
}
