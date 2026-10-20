import { StringDecoder } from 'node:string_decoder';

// Pi frames JSON with LF. Unicode line separators inside JSON strings are data.
export function readLfLines(input, onLine) {
  const decoder = new StringDecoder('utf8');
  let fragments = [],
    closed = false;
  const data = (chunk) => {
    const text = decoder.write(chunk);
    let start = 0,
      end;
    // Scan each decoded chunk once; join a fragmented frame only at its LF.
    while (!closed && (end = text.indexOf('\n', start)) !== -1) {
      const part = text.slice(start, end);
      const line = fragments.length ? [...fragments, part].join('') : part;
      fragments = [];
      start = end + 1;
      onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
    if (!closed && start < text.length) fragments.push(text.slice(start));
  };
  // An unfinished frame at EOF is not a protocol response.
  const close = () => {
    closed = true;
    input.off('data', data);
    input.off('end', close);
    fragments = [];
  };
  input.on('data', data);
  input.once('end', close);
  return { close };
}
