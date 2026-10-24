import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SCHEMA_VERSION = 95;
const COLUMNS = {
  schema_migrations: ['version'],
  session_projects: ['session_id', 'harness', 'project_path'],
  session_meta: ['session_id', 'harness', 'counter', 'cached_m0_bytes'],
  compartments: [
    'id',
    'session_id',
    'harness',
    'sequence',
    'title',
    'content',
    'p1',
    'p2',
    'p3',
    'start_message_id',
    'end_message_id',
    'start_block_index',
    'end_block_index',
    'rebase_status',
    'created_at',
  ],
  memories: [
    'id',
    'project_path',
    'category',
    'content',
    'importance',
    'status',
    'expires_at',
    'source_session_id',
    'source_type',
    'verification_status',
    'updated_at',
    'superseded_by_memory_id',
  ],
};

function fail(code, cause) {
  return new Error(code, cause === undefined ? undefined : { cause });
}

function validateOptions(options) {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => key !== 'database') ||
    typeof options.database !== 'string' ||
    !path.isAbsolute(options.database) ||
    options.database.includes('\0')
  )
    throw fail('MAGIC_CONTEXT_INVALID_OPTIONS');
  return options.database;
}

function validateSchema(db) {
  for (const [table, required] of Object.entries(COLUMNS)) {
    const columns = new Set(
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name),
    );
    if (required.some((name) => !columns.has(name))) throw fail('MAGIC_CONTEXT_SCHEMA_MISMATCH');
  }
  const { version } = db
    .prepare('SELECT MAX(version) AS version FROM schema_migrations WHERE version < 10000')
    .get();
  if (version !== SCHEMA_VERSION) throw fail('MAGIC_CONTEXT_SCHEMA_MISMATCH');
}

function withDatabase(database, read) {
  let db;
  try {
    db = new DatabaseSync(database, { readOnly: true });
  } catch (cause) {
    throw fail('MAGIC_CONTEXT_DATABASE_UNAVAILABLE', cause);
  }
  try {
    // These pragmas affect this connection only. BEGIN takes a coherent read
    // snapshot; neither plugin initialization nor migration code is imported.
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN');
    validateSchema(db);
    return read(db);
  } catch (cause) {
    if (cause.message?.startsWith('MAGIC_CONTEXT_')) throw cause;
    throw fail('MAGIC_CONTEXT_DATABASE_READ_FAILED', cause);
  } finally {
    db.close();
  }
}

async function hasGitMetadata(directory) {
  for (let current = directory; ; current = path.dirname(current)) {
    try {
      await fs.stat(path.join(current, '.git'));
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (path.dirname(current) === current) return false;
  }
}

async function projectIdentity(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw fail('MAGIC_CONTEXT_INVALID_SESSION');
  const directory = path.resolve(cwd);
  const fallback = `dir:${createHash('md5').update(directory, 'utf8').digest('hex').slice(0, 12)}`;
  try {
    if (!(await fs.stat(directory)).isDirectory()) throw fail('MAGIC_CONTEXT_INVALID_SESSION');
    const real = await fs.realpath(directory);
    if (
      !(await hasGitMetadata(directory)) &&
      !(real !== directory && (await hasGitMetadata(real)))
    ) {
      return fallback;
    }
    const env = { ...process.env, LC_ALL: 'C', LANG: 'C', GIT_OPTIONAL_LOCKS: '0' };
    for (const key of Object.keys(env)) {
      if (key.startsWith('GIT_') && key !== 'GIT_OPTIONAL_LOCKS') delete env[key];
    }
    const git = (args) =>
      execFileAsync('git', args, {
        cwd: directory,
        env,
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 65536,
        windowsHide: true,
      });
    try {
      const { stdout } = await git(['rev-list', '--max-parents=0', 'HEAD']);
      const roots = stdout.trim().split(/\s+/).sort();
      if (!roots.length || roots.some((id) => !/^[0-9a-f]{40,64}$/.test(id))) {
        throw fail('MAGIC_CONTEXT_PROJECT_IDENTITY_UNAVAILABLE');
      }
      return `git:${roots[0]}`;
    } catch (cause) {
      if (cause.code === 128 && /fatal: not a git repository/.test(cause.stderr ?? ''))
        return fallback;
      // An unborn repository uses the current directory identity in MC. Other
      // Git failures do not justify borrowing another project's memories.
      try {
        await git(['symbolic-ref', '--quiet', 'HEAD']);
      } catch {
        throw fail('MAGIC_CONTEXT_PROJECT_IDENTITY_UNAVAILABLE', cause);
      }
      try {
        await git(['rev-parse', '--verify', '--quiet', 'HEAD']);
      } catch (unborn) {
        if (unborn.code === 1 && !unborn.killed) return fallback;
      }
      throw fail('MAGIC_CONTEXT_PROJECT_IDENTITY_UNAVAILABLE', cause);
    }
  } catch (cause) {
    if (cause.message?.startsWith('MAGIC_CONTEXT_')) throw cause;
    throw fail('MAGIC_CONTEXT_PROJECT_IDENTITY_UNAVAILABLE', cause);
  }
}

function liveEvidence(owner) {
  if (owner?.available !== true) return false;
  return (
    (owner.commands ?? []).includes('ctx-status') && (owner.commands ?? []).includes('ctx-recomp')
  );
}

function activationEvidence(db, context) {
  const nativeId = context.session.native_id;
  if (liveEvidence(context.owner)) return true;
  if (
    db
      .prepare("SELECT 1 FROM compartments WHERE session_id = ? AND harness = 'pi' LIMIT 1")
      .get(nativeId)
  )
    return true;
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM session_meta WHERE session_id = ? AND harness = 'pi' AND (counter > 0 OR length(cached_m0_bytes) > 0)",
      )
      .get(nativeId),
  );
}

function sessionEvidence(db, context, identity) {
  const mapping = db
    .prepare("SELECT project_path FROM session_projects WHERE session_id = ? AND harness = 'pi'")
    .get(context.session.native_id);
  return Boolean(mapping && mapping.project_path === identity && activationEvidence(db, context));
}

function nativeEntryId(id) {
  return typeof id === 'string' && id.length > 0 && !/^(pi-msg-|synth-user-)/.test(id)
    ? id
    : undefined;
}

function compartmentItem(row, capturedAt) {
  const text = row.p1?.trim() ? row.p1 : row.content;
  const preview = row.p2?.trim() ? row.p2 : row.p3?.trim() ? row.p3 : text;
  const source = {
    provider: 'magic-context',
    state: 'stored',
    captured_at: capturedAt,
    compartment_id: row.id,
    sequence: row.sequence,
    created_at: row.created_at,
  };
  source.mc_start_message_id = row.start_message_id;
  source.mc_end_message_id = row.end_message_id;
  if (row.start_block_index !== null) source.mc_start_block_index = row.start_block_index;
  if (row.end_block_index !== null) source.mc_end_block_index = row.end_block_index;
  const end = nativeEntryId(row.end_message_id);
  if (row.rebase_status === 'ok' && end) {
    // MC folds tool results into the next user message, so its part indexes
    // and starting message do not describe an exact native range. Only expose
    // the ending entry as a historical leaf whose ancestry Bridge can verify.
    source.source_entry_id = end;
    source.source_relation = 'history_leaf';
  } else {
    source.source_unavailable =
      row.rebase_status === 'unresolved' ? 'unresolved_boundary' : 'no_native_history_leaf';
  }
  return { id: `compartment:${row.id}`, kind: 'summary', title: row.title, text, preview, source };
}

function memoryItem(row, capturedAt) {
  return {
    id: `memory:${row.id}`,
    kind: 'memory',
    title: row.category,
    text: row.content,
    source: {
      provider: 'magic-context',
      state: 'stored',
      scope: 'own_project',
      captured_at: capturedAt,
      memory_id: row.id,
      status: row.status,
      verification: row.verification_status,
      updated_at: row.updated_at,
      origin_type: row.source_type,
      ...(row.source_session_id ? { origin_session_id: row.source_session_id } : {}),
    },
  };
}

export function createMagicContextReader(options) {
  const database = validateOptions(options);
  withDatabase(database, () => {});
  function validateSession(context) {
    if (typeof context?.session?.native_id !== 'string' || !context.session.native_id) {
      throw fail('MAGIC_CONTEXT_INVALID_SESSION');
    }
  }
  return {
    async matches(context) {
      validateSession(context);
      const candidate = withDatabase(database, (db) =>
        Boolean(
          db
            .prepare("SELECT 1 FROM session_projects WHERE session_id = ? AND harness = 'pi'")
            .get(context.session.native_id) && activationEvidence(db, context),
        ),
      );
      if (!candidate) return false;
      const identity = await projectIdentity(context.session.cwd);
      return withDatabase(database, (db) => sessionEvidence(db, context, identity));
    },
    async read(context) {
      if (context.request?.leaf_id !== undefined)
        throw fail('MAGIC_CONTEXT_EXPLICIT_LEAF_UNSUPPORTED');
      validateSession(context);
      const identity = await projectIdentity(context.session.cwd);
      return withDatabase(database, (db) => {
        if (!sessionEvidence(db, context, identity)) throw fail('MAGIC_CONTEXT_SESSION_MISMATCH');
        const capturedAt = Date.now();
        const compartments = db
          .prepare(
            `SELECT id, sequence, title, content, p1, p2, p3, start_message_id, end_message_id,
             start_block_index, end_block_index, rebase_status, created_at
           FROM compartments WHERE session_id = ? AND harness = 'pi' ORDER BY sequence ASC, id ASC`,
          )
          .all(context.session.native_id);
        const memories = db
          .prepare(
            `SELECT id, category, content, status, verification_status, updated_at, source_type, source_session_id
           FROM memories WHERE project_path = ? AND status IN ('active', 'permanent')
             AND (expires_at IS NULL OR expires_at > ?) AND superseded_by_memory_id IS NULL
           ORDER BY COALESCE(importance, 50) ASC, updated_at ASC, id ASC`,
          )
          .all(identity, capturedAt);
        const preset = context.request?.preset ?? 'latest';
        const selectedCompartments =
          preset === 'full' ? compartments : compartments.slice(preset === 'recent' ? -4 : -2);
        const selectedMemories =
          preset === 'full' ? memories : memories.slice(preset === 'recent' ? -5 : -3);
        return {
          native: true,
          coverage: [
            { type: 'summary', selected: selectedCompartments.length, total: compartments.length },
            { type: 'memory', selected: selectedMemories.length, total: memories.length },
          ],
          items: [
            ...selectedCompartments.map((row) => compartmentItem(row, capturedAt)),
            ...selectedMemories.map((row) => memoryItem(row, capturedAt)),
          ],
        };
      });
    },
  };
}

export default {
  id: 'magic-context',
  start({ id, services, onStop }, options) {
    onStop(services.sessionReaders.register(id, createMagicContextReader(options)));
  },
};
