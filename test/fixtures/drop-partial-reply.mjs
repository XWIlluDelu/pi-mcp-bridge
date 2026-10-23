import net from 'node:net';
import { readLfLines } from '../../src/lf-lines.mjs';

// Observe the partial frame after the production receiver parsed it, then
// fail that connection without waiting for an arbitrary ACK deadline.
export function dropPartialReply(t) {
  const received = Promise.withResolvers(),
    connect = net.createConnection;
  t.mock.method(net, 'createConnection', (...args) => {
    const socket = connect(...args);
    queueMicrotask(() => {
      const lines = readLfLines(socket, (line) => {
        const response = JSON.parse(line);
        if (response.partial !== true) return;
        received.resolve(response.data);
        socket.destroy(new Error('FIXTURE_CONNECTION_LOST_AFTER_PARTIAL'));
      });
      socket.once('close', lines.close);
    });
    return socket;
  });
  return received.promise;
}
