// Exercise late acknowledgements without exposing a public timeout parameter.
import { PiRpc } from '../../src/rpc.mjs';
import { AttachedRuntime } from '../../src/attachments.mjs';

export function ackTimeout(t, operations, timeout = 50) {
  const dispatch = PiRpc.prototype.dispatch;
  const rpc = t.mock.method(PiRpc.prototype, 'dispatch', function (command, wait, ...rest) {
    return dispatch.call(
      this,
      command,
      operations.includes(command.type) ? timeout : wait,
      ...rest,
    );
  });
  const request = AttachedRuntime.prototype.request;
  const attached = t.mock.method(
    AttachedRuntime.prototype,
    'request',
    function (op, body, wait, ...rest) {
      return request.call(
        this,
        op,
        body,
        wait !== null && operations.includes(op) ? timeout : wait,
        ...rest,
      );
    },
  );
  return () => {
    rpc.mock.restore();
    attached.mock.restore();
  };
}
