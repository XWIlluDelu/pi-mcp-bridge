// Poll a fixture condition until it returns a truthy value, which is returned.
export async function until(fn, label = 'fixture condition', timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out: ' + label);
}
