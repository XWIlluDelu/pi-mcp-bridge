import fs from 'node:fs/promises';

export const text = (text) => ({ type: 'text', text });
export const message = (id, parentId, role, content, extra = {}) => ({
  type: 'message',
  id,
  parentId,
  timestamp: '2026-01-01T00:00:00Z',
  message: { role, content, timestamp: 0, ...extra },
});
export const append = (session, entries) =>
  fs.appendFile(session.file, entries.map(JSON.stringify).join('\n') + '\n');
