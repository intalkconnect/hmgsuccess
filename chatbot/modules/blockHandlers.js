import { substituteVariables } from '../utils/vars.js';
import axios from 'axios';
import vm from 'vm';
export async function executeBlock(block, vars, message) {
  let content = '';
  // substitui variáveis e executa api_call ou script
  if (block.content) {
    content = typeof block.content === 'string'
      ? substituteVariables(block.content, vars)
      : JSON.parse(substituteVariables(JSON.stringify(block.content), vars));
  }
  switch (block.type) {
case 'api_call': {
          const url = substituteVariables(block.url, sessionVars);
          const payload = JSON.parse(substituteVariables(JSON.stringify(block.body || {}), sessionVars));
          const res = await axios({ method: block.method || 'GET', url, data: payload });
          sessionVars.responseStatus = res.status;
          sessionVars.responseData = res.data;
          if (block.script) {
            const sandbox = { response: res.data, vars: sessionVars, output: '' };
            vm.createContext(sandbox);
            vm.runInContext(block.script, sandbox);
            content = sandbox.output;
          } else {
            content = JSON.stringify(res.data);
          }
          if (block.outputVar) sessionVars[block.outputVar] = content;
          if (block.statusVar) sessionVars[block.statusVar] = res.status;
          break;
        }
        case 'script': {
          const sandbox = { vars: sessionVars, output: '' };
          const code = `${block.code}\noutput = ${block.function};`;
          vm.createContext(sandbox);
          vm.runInContext(code, sandbox);
          content = sandbox.output?.toString() || '';
          if (block.outputVar) sessionVars[block.outputVar] = sandbox.output;
          break;
        }
        default:
          break;
      }
    default: break;
  }
  return { content, nextBlock: block.next, delaySec: parseInt(block.awaitTimeInSeconds || '0', 10) };
}
