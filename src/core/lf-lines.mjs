const EMPTY = Buffer.alloc(0);

// Scan bytes before decoding. A fragmented frame grows geometrically and an
// oversized line can be discarded without affecting the next frame.
function framer(onFrame, { maxBytes = Infinity, onOverflow } = {}) {
  let buffer = EMPTY,
    length = 0,
    discarding = false,
    closed = false;
  function reset() {
    buffer = EMPTY;
    length = 0;
  }
  return {
    push(chunk) {
      if (typeof chunk === 'string') chunk = Buffer.from(chunk);
      for (let start = 0; !closed && start < chunk.length;) {
        const newline = chunk.indexOf(10, start);
        const part = chunk.subarray(start, newline < 0 ? chunk.length : newline);
        if (!discarding) {
          const size = length + part.length;
          if (size > maxBytes) {
            reset();
            discarding = true;
            onOverflow();
          } else if (newline >= 0 && !length) onFrame(part);
          else {
            if (size > buffer.length) {
              const next = Buffer.allocUnsafe(
                Math.min(maxBytes, Math.max(size, buffer.length * 2, 4096)),
              );
              buffer.copy(next, 0, 0, length);
              buffer = next;
            }
            part.copy(buffer, length);
            length = size;
            if (newline >= 0) {
              const frame = buffer.subarray(0, length);
              reset();
              onFrame(frame);
            }
          }
        }
        if (newline < 0) return;
        discarding = false;
        start = newline + 1;
      }
    },
    tail: () => buffer.subarray(0, length),
    close() {
      closed = true;
      reset();
    },
  };
}

// Saved JSONL can have a valid final record without LF.
export async function scanSavedLines(stream, consume) {
  const frames = framer((frame) => consume(frame.toString('utf8')));
  for await (const chunk of stream) frames.push(chunk);
  const tail = frames.tail();
  if (tail.length) consume(tail.toString('utf8'));
  return tail.length > 0;
}

// An unfinished frame at EOF is not a protocol response.
export function readLfFrames(input, onFrame, options) {
  const frames = framer(onFrame, options);
  const close = () => {
    frames.close();
    input.off('data', frames.push);
    input.off('end', close);
  };
  input.on('data', frames.push);
  input.once('end', close);
  return { close };
}

export function readLfLines(input, onLine, options) {
  return readLfFrames(
    input,
    (frame) =>
      onLine(frame.toString('utf8', 0, frame.at(-1) === 13 ? frame.length - 1 : frame.length)),
    options,
  );
}
