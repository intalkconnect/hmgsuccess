import { dbPool } from '../services/db.js'

export async function distribuirTicket(userId, queueName) {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');

    // 1. Buscar configuração
    const configQuery = await client.query(
      'SELECT value FROM settings WHERE key = $1 LIMIT 1',
      ['distribuicao_tickets']
    );
    const modoDistribuicao = configQuery.rows[0]?.value || 'manual';

    if (modoDistribuicao === 'manual') {
      console.log('[📥 Manual] Aguardando agente puxar o ticket.');
      await client.query('COMMIT');
      return;
    }

    // 2. Determinar fila do cliente
    let filaCliente = queueName;
    if (!filaCliente) {
      const clienteQuery = await client.query(
        'SELECT fila FROM clientes WHERE user_id = $1 LIMIT 1',
        [userId]
      );
      filaCliente = clienteQuery.rows[0]?.fila || 'Default';
      if (!queueName) {
        console.warn('⚠️ Cliente não tem fila definida, usando fila Default.');
      }
    }

    // 3. Verificar ticket aberto existente
    const ticketAbertoQuery = await client.query(
      'SELECT * FROM tickets WHERE user_id = $1 AND status = $2 LIMIT 1',
      [userId, 'open']
    );
    const ticketAberto = ticketAbertoQuery.rows[0];

    if (ticketAberto) {
      await client.query('COMMIT');
      return;
    }

    // 4. Buscar atendentes online da fila
    const atendentesQuery = await client.query(
      'SELECT id, filas FROM atendentes WHERE status = $1',
      ['online']
    );
    const candidatos = atendentesQuery.rows.filter(a => 
      Array.isArray(a.filas) && a.filas.includes(filaCliente)
    );

    if (!candidatos.length) {
      console.warn(`⚠️ Nenhum atendente online para a fila: "${filaCliente}". Criando ticket sem atendente.`);
      
      const createTicketQuery = await client.query(
        `INSERT INTO tickets (
          user_id, fila, assigned_to, status, created_at, updated_at
        ) VALUES (
          $1, $2, $3, 'open', NOW(), NOW()
        ) RETURNING id`,
        [userId, filaCliente, null]
      );
      
      console.log(`[✅ Criado] Ticket SEM atendente para fila "${filaCliente}", número: ${createTicketQuery.rows[0].id}`);
      await client.query('COMMIT');
      return;
    }

    // 5. Buscar contagem de tickets por atendente
    const cargasQuery = await client.query(`
      SELECT assigned_to, COUNT(*) as total_tickets 
      FROM tickets 
      WHERE status = 'open' AND assigned_to IS NOT NULL
      GROUP BY assigned_to
    `);
    const mapaCargas = {};
    cargasQuery.rows.forEach(linha => {
      mapaCargas[linha.assigned_to] = parseInt(linha.total_tickets);
    });

    // 6. Escolher atendente com menos carga
    candidatos.sort((a, b) => {
      const cargaA = mapaCargas[a.id] || 0;
      const cargaB = mapaCargas[b.id] || 0;
      return cargaA - cargaB;
    });

    const escolhido = candidatos[0]?.id;
    if (!escolhido) {
      console.warn('⚠️ Não foi possível determinar atendente.');
      await client.query('COMMIT');
      return;
    }

    // 7. Atribuir ou criar ticket
    if (ticketAberto) {
      await client.query(
        'UPDATE tickets SET assigned_to = $1, updated_at = NOW() WHERE id = $2',
        [escolhido, ticketAberto.id]
      );
      console.log(`[✅ Atualizado] Ticket atribuído a ${escolhido}`);
    } else {
      const createTicketQuery = await client.query(
        `INSERT INTO tickets (
          user_id, fila, assigned_to, status, created_at, updated_at
        ) VALUES (
          $1, $2, $3, 'open', NOW(), NOW()
        ) RETURNING id`,
        [userId, filaCliente, escolhido]
      );
      console.log(`[✅ Criado] Novo ticket atribuído a ${escolhido}, número: ${createTicketQuery.rows[0].id}`);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Erro na distribuição de ticket:', error);
    throw error;
  } finally {
    client.release();
  }
}
