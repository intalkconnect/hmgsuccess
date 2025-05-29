export function substituteVariables(template, vars) {
  return template.replace(/{{(\w+)}}/g, (_, key) => vars[key] || '');
}
