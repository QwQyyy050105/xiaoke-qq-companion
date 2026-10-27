// A subprocess-only resolver: prove plain text startup does not load media code.
export async function resolve(specifier, context, nextResolve) {
  const name = ['katex', 'playwright-core', 'silk-wasm'].find(name => specifier === name || specifier.startsWith(name + '/'));
  if (name) throw new Error('optional_dependency_requested:' + name);
  return nextResolve(specifier, context);
}
