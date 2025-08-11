// engine/ticketManager.js (ou onde está seu distribuirTicket)
import { dbPool } from '../services/db.js';
import { v4 as uuidv4 } from 'uuid';

// 🔧 Helper: monta o user_id persistido por canal
function buildStorageUserId(rawUserId, channel) {
  // já vem com sufixo? mantém
  if (/@[a-z]\./i.test(String(rawUserId))) return String(rawUserId);

  switch ((channel || '').toLowerCase()) {
    case 'whatsapp':
    case 'wa':
      return `${rawUserId}@w.msgcli.net`;
    case 'telegram':
    case 'tg':
      return `${rawUserId}@t.msgcli.net`;
    case 'webchat':
    case 'web':
      return `${rawUserId}@web`;
    default:
      // fallback: mantém cru (ou defina um sufixo padrão do seu sistema)
      return String(rawUserId);
  }
}

/**
 * Distribui ticket e insere mensagem de sistema "Ticket #123".
 * ATENÇÃO: agora recebe rawUserId + channel para compor o user_id correto.
 */
export async function distribuirTicket(rawUserId, queueName, channel) {
  const client = await dbPool.connect();
  const storageUserId = buildStorageUserId(rawUserId, channel);

  try {
    await client.query('BEGIN');

    async function inserirMensagemSistema(ticketNumber) {
      const systemMessage = `Ticket #${ticketNumber}`;
      const systemMessageId = uuidv4(); // genérico (não "whatsappMessageId")

      await client.query(
        `
        INSERT INTO messages (
          user_id,
          type,
          direction,
          content,
          timestamp,
          message_id
        ) VALUES (
          $1, 'system', 'system', $2, NOW(), $3
        )
        `,
        [storageUserId, systemMessage, systemMessageId]
      );
    }

    // 🔍 Verificar se já existe um ticket aberto (usa SEMPRE storageUserId)
    const ticketAbertoQuery = await client.query(
      'SELECT * FROM tickets WHERE user_id = $1 AND status = $2 LIMIT 1',
      [storageUserId, 'open']
    );
    const ticketAberto = ticketAbertoQuery.rows[0];
    if (ticketAberto) {
      await client.query('COMMIT');
      return { ticketExists: true, ticketId: ticketAberto.id, userId: storageUserId };
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
        [storageUserId]
      );
      filaCliente = filaResult.rows[0]?.fila || 'Default';
    }

    if (modoDistribuicao === 'manual') {
      console.log('[📥 Manual] Criando ticket aguardando agente.');

      const createTicketQuery = await client.query(
        `SELECT create_ticket($1, $2, $3) as ticket_number`,
        [storageUserId, filaCliente, null]
      );

      const ticketNumber = createTicketQuery.rows[0].ticket_number;
      await inserirMensagemSistema(ticketNumber);

      await client.query('COMMIT');
      return {
        mode: 'manual',
        ticketNumber,
        assignedTo: null,
        userId: storageUserId,
      };
    }

    // 3. Buscar atendentes online da fila
    const atendentesQuery = await client.query(
      'SELECT email, filas FROM atendentes WHERE status = $1',
      ['online']
    );
    const candidatos = atendentesQuery.rows.filter(
      a => Array.isArray(a.filas) && a.filas.includes(filaCliente)
    );

    if (!candidatos.length) {
      console.warn(`⚠️ Nenhum atendente online para a fila: "${filaCliente}". Criando ticket sem atendente.`);

      const createTicketQuery = await client.query(
        `SELECT create_ticket($1, $2, $3) as ticket_number`,
        [storageUserId, filaCliente, null]
      );

      const ticketNumber = createTicketQuery.rows[0].ticket_number;
      console.log(`[✅ Criado] Ticket SEM atendente para fila "${filaCliente}", número: ${ticketNumber}`);

      await client.query('COMMIT');
      return {
        success: true,
        ticketNumber,
        assignedTo: null,
        mode: 'auto-no-agent',
        userId: storageUserId,
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
      return { success: false, error: 'No agent available', userId: storageUserId };
    }

    // 6. Criar ticket atribuído
    const createTicketQuery = await client.query(
      `SELECT create_ticket($1, $2, $3) as ticket_number`,
      [storageUserId, filaCliente, escolhido]
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
      userId: storageUserId,
    };

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Erro na distribuição de ticket:', error);
    return { success: false, error: error.message };
  } finally {
    client.release();
  }
}
