// engine/ticketManager.js
import { supabase } from '../services/db.js'

export async function distribuirTicket(userId) {
  // 1. Buscar configuração
  const { data: config } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'distribuicao_tickets')
    .single();

  const modoDistribuicao = config?.value || 'manual';

  if (modoDistribuicao === 'manual') {
    console.log('[📥 Manual] Aguardando agente puxar o ticket.');
    return;
  }

  // 2. Buscar fila do cliente
  const { data: cliente } = await supabase
    .from('clientes')
    .select('fila')
    .eq('user_id', userId)
    .maybeSingle();

  const filaCliente = cliente?.fila;
  if (!filaCliente) {
    filaCliente = 'Default';
    console.warn('⚠️ Cliente não tem fila definida.');
    return;
  }

  // 3. Verifica se já existe ticket aberto
  const { data: ticketAberto } = await supabase
    .from('tickets')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'aberto')
    .maybeSingle();

  if (ticketAberto?.assigned_to) {
    console.log(`[🎟️] Ticket já atribuído a ${ticketAberto.assigned_to}.`);
    return;
  }

  // 4. Buscar atendentes online dessa fila
  const { data: atendentes } = await supabase
    .from('atendentes')
    .select('id, filas')
    .eq('status', 'online');

  const candidatos = atendentes?.filter((a) =>
    Array.isArray(a.filas) && a.filas.includes(filaCliente)
  );

if (!candidatos?.length) {
  console.warn(`⚠️ Nenhum atendente online para a fila: "${fila}". Criando ticket sem atendente.`);

  // Se já existe ticket, mantém sem alteração
  if (!ticketAberto) {
    await supabase.from('tickets').insert({
      user_id: userId,
      status: 'aberto',
      atendente: null,
      fila,
      criado_em: new Date().toISOString()
    });
    console.log(`[✅ Criado] Ticket SEM atendente para fila "${fila}"`);
  }

  return;
}

  // 5. Buscar contagem de tickets por atendente
  const { data: cargas, error } = await supabase
    .rpc('contar_tickets_ativos_por_atendente');

  if (error) {
    console.error('Erro ao contar tickets por atendente:', error);
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
    await supabase
      .from('tickets')
      .update({ assigned_to: escolhido })
      .eq('id', ticketAberto.id);
    console.log(`[✅ Atualizado] Ticket atribuído a ${escolhido}`);
  } else {
    await supabase.from('tickets').insert({
      user_id: userId,
      status: 'aberto',
      assigned_to: escolhido,
      criado_em: new Date().toISOString()
    });
    console.log(`[✅ Criado] Novo ticket atribuído a ${escolhido}`);
  }
}
