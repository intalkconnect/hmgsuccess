// engine/utils.js
export function evaluateConditions(conditions = [], sessionVars = {}) {
  for (const { type, variable, value } of conditions) {
    const actual = sessionVars[variable];
    switch (type) {
      case 'exists':
        if (actual == null) return false;
        break;
      case 'not_exists':
        if (actual != null) return false;
        break;
      case 'equals':
        if (actual != value) return false;
        break;
      case 'not_equals':
        if (actual == value) return false;
        break;
      case 'contains':
        if (!String(actual).includes(value)) return false;
        break;
      case 'regex':
        if (!new RegExp(value).test(actual)) return false;
        break;
      case 'greater_than':
        if (!(parseFloat(actual) > parseFloat(value))) return false;
        break;
      case 'less_than':
        if (!(parseFloat(actual) < parseFloat(value))) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

export function determineNextBlock(block, sessionVars, flow, currentBlockId) {
  // 1) Tenta todas as ações condicionais
  for (const action of block.actions || []) {
    if (evaluateConditions(action.conditions, sessionVars)) {
      return action.next;
    }
  }

  // 2) Se não achar, utiliza defaultNext (se existir)
  if (block.defaultNext && flow.blocks[block.defaultNext]) {
    return block.defaultNext;
  }

  // 3) Se estiver em onerror, retorna previousBlock
  if (currentBlockId === 'onerror' && sessionVars.previousBlock) {
    return sessionVars.previousBlock;
  }

  // 4) Senão, retorna null para indicar sem transição
  return null;
}
