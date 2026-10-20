// Every owner configuration declares its complete baseline policy.
export const denyAllPermissions = () => ({
  list: false,
  read: false,
  send: false,
  command: false,
  stop: false,
  create: false,
  delete: false,
});
