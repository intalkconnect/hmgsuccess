import { dbPool } from '../services/db.js';
import { v4 as uuidv4 } from 'uuid';

export async function distribuirTicket(userId, queueName) {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');

    async function inserirMensagemSistema(ticketNumber) {
  const systemMessage = "Ticket criado";
  const whatsappMessageId = uuidv4(); // gerar ID único

  await client.query(`
    INSERT INTO messages (
      user_id,
      type,
      direction,
      content,
      timestamp,
      whatsapp_message_id
    ) VALUES (
      $1, 'system', 'system', $2, NOW(), $3
    )
  `, [
    userId,
    JSON.stringify(systemMessage),
    whatsappMessageId
  ]);
}

    // 🔍 Verificar se já existe um ticket aberto
    const ticketAbertoQuery = await client.query(
      'SELECT * FROM tickets WHERE user_id = $1 AND status = $2 LIMIT 1',
      [userId, 'open']
    );
    const ticketAberto = ticketAbertoQuery.rows[0];
    if (ticketAberto) {
      await client.query('COMMIT');
      return { ticketExists: true, ticketId: ticketAberto.id };
    }

    // 1. Buscar configuração
    const configQuery = await client.query(
      'SELECT value FROM settings WHERE key = $1 LIMIT 1',
      ['distribuicao_tickets']
    );
    const modoDistribuicao = configQuery.rows[0]?.value || 'manual';

    // 2. Determinar fila do cliente
    let filaCliente = queueName;
    if (!filaCliente) {
      const filaResult = await client.query(
        'SELECT fila FROM clientes WHERE user_id = $1 LIMIT 1',
        [userId]
      );
      filaCliente = filaResult.rows[0]?.fila || 'Default';
    }

    if (modoDistribuicao === 'manual') {
      console.log('[📥 Manual] Criando ticket aguardando agente.');

      const createTicketQuery = await client.query(
        `SELECT create_ticket($1, $2, $3) as ticket_number`,
        [userId, filaCliente, null]
      );

      const ticketNumber = createTicketQuery.rows[0].ticket_number;

      await inserirMensagemSistema(ticketNumber);
      
      await client.query('COMMIT');
      return {
        mode: 'manual',
        ticketNumber,
        assignedTo: null,
      };
    }

    // 3. Buscar atendentes online da fila
    const atendentesQuery = await client.query(
      'SELECT email, filas FROM atendentes WHERE status = $1',
      ['online']
    );
    const candidatos = atendentesQuery.rows.filter(a =>
      Array.isArray(a.filas) && a.filas.includes(filaCliente)
    );

    if (!candidatos.length) {
      console.warn(`⚠️ Nenhum atendente online para a fila: "${filaCliente}". Criando ticket sem atendente.`);

      const createTicketQuery = await client.query(
        `SELECT create_ticket($1, $2, $3) as ticket_number`,
        [userId, filaCliente, null]
      );

      const ticketNumber = createTicketQuery.rows[0].ticket_number;
      console.log(`[✅ Criado] Ticket SEM atendente para fila "${filaCliente}", número: ${ticketNumber}`);

      await client.query('COMMIT');
      return {
        success: true,
        ticketNumber,
        assignedTo: null,
        mode: 'auto-no-agent',
      };
    }

    // 4. Contagem de tickets por atendente
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

    // 5. Escolher atendente com menor carga
    candidatos.sort((a, b) => {
      const cargaA = mapaCargas[a.email] || 0;
      const cargaB = mapaCargas[b.email] || 0;
      return cargaA - cargaB;
    });

    const escolhido = candidatos[0]?.email;
    if (!escolhido) {
      console.warn('⚠️ Não foi possível determinar atendente.');
      await client.query('COMMIT');
      return { success: false, error: 'No agent available' };
    }

    // 6. Criar ticket atribuído
    const createTicketQuery = await client.query(
      `SELECT create_ticket($1, $2, $3) as ticket_number`,
      [userId, filaCliente, escolhido]
    );

    const ticketNumber = createTicketQuery.rows[0].ticket_number;
    await inserirMensagemSistema(ticketNumber);
    console.log(`[✅ Criado] Novo ticket atribuído a ${escolhido}, número: ${ticketNumber}`);

    await client.query('COMMIT');
    return {
      success: true,
      ticketNumber,
      assignedTo: escolhido,
      mode: 'auto-created',
    };

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Erro na distribuição de ticket:', error);
    return { success: false, error: error.message };
  } finally {
    client.release();
  }
}
