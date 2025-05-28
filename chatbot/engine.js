export function processMessage(message, flow) {
  const step = flow.steps.find((s) => s.trigger === message);
  return step ? step.response : 'Desculpe, não entendi.';
}