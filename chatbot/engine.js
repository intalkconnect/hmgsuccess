import { substituteVariables } from '../utils/vars.js';
import axios from 'axios';
import vm from 'vm';

export async function processMessage(message, flow, vars) {
  if (!flow || !flow.blocks || !flow.start) return flow?.onError?.content || 'Erro interno no bot';

  let currentBlockId = flow.start;
  let response = '';

  while (currentBlockId) {
    const block = flow.blocks[currentBlockId];
    if (!block) break;

    let content = block.content ? substituteVariables(block.content, vars) : '';

    try {
      switch (block.type) {
        case 'text':
        case 'image':
        case 'audio':
        case 'video':
        case 'file':
          response = content;
          break;

        case 'api_call':
          const payload = JSON.parse(substituteVariables(JSON.stringify(block.body || {}), vars));
          const apiRes = await axios({
            method: block.method || 'GET',
            url: block.url,
            data: payload
          });
          if (block.script) {
            const sandbox = { response: apiRes.data, vars };
            vm.createContext(sandbox);
            response = vm.runInContext(block.script, sandbox);
          } else {
            response = JSON.stringify(apiRes.data);
          }
          break;

        default:
          response = '[Bloco não reconhecido]';
      }

      currentBlockId = block.next || null;
    } catch (err) {
      console.error('Erro no bloco:', currentBlockId, err);
      return flow.onError?.content || 'Erro no fluxo do bot.';
    }
  }

  return response;
}
