import { StringDecoder } from 'node:string_decoder';

// Pi frames JSON with LF. Unicode line separators inside JSON strings are data.
export function readLfLines(input, onLine) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const data = chunk => {
    pending += decoder.write(chunk);
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
  };
  // An unfinished frame at EOF is not a protocol response.
  const close = () => { input.off('data', data); input.off('end', close); pending = ''; };
  input.on('data', data);
  input.once('end', close);
  return {close};
}
