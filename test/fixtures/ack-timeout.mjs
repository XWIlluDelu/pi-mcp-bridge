// Exercise late acknowledgements without exposing a public timeout parameter.
import { PiRpc } from '../../src/runtime/rpc.mjs';
import { AttachedRuntime } from '../../src/runtime/attachments.mjs';

export function ackTimeout(t, operations, timeout = 50) {
  // A null timeout is an owned compact transport that waits on its caller's signal.
  const shorten = (type, options = {}) =>
    operations.includes(type) && options.timeout !== null ? { ...options, timeout } : options;
  const dispatch = PiRpc.prototype.dispatch;
  const rpc = t.mock.method(PiRpc.prototype, 'dispatch', function (command, options) {
    return dispatch.call(this, command, shorten(command.type, options));
  });
  const request = AttachedRuntime.prototype.request;
  const attached = t.mock.method(
    AttachedRuntime.prototype,
    'request',
    function (op, body, options) {
      return request.call(this, op, body, shorten(op, options));
    },
  );
  return () => {
    rpc.mock.restore();
    attached.mock.restore();
  };
}
