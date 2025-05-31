// engine/runners.js
import axios from 'axios';
import vm from 'vm';
import { substituteVariables } from '../utils/vars.js';

export async function runApiCall(block, sessionVars) {
  const url = substituteVariables(block.url, sessionVars);
  const payload = JSON.parse(
    substituteVariables(JSON.stringify(block.body || {}), sessionVars)
  );
  const res = await axios({ method: block.method || 'GET', url, data: payload });
  sessionVars.responseStatus = res.status;
  sessionVars.responseData = res.data;

  if (block.script) {
    const sandbox = { response: res.data, vars: sessionVars, output: '' };
    vm.createContext(sandbox);
    vm.runInContext(block.script, sandbox);
    return sandbox.output;
  }

  if (block.outputVar) sessionVars[block.outputVar] = JSON.stringify(res.data);
  if (block.statusVar) sessionVars[block.statusVar] = res.status;
  return JSON.stringify(res.data);
}

export async function runScript(block, sessionVars) {
  const sandbox = { vars: sessionVars, output: '' };
  const code = `${block.code}\noutput = ${block.function};`;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  if (block.outputVar) sessionVars[block.outputVar] = sandbox.output;
  return sandbox.output?.toString() || '';
}
