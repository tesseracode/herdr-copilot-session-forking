import { randomBytes } from 'node:crypto';
import { stat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ForkError } from './errors.mjs';
import { createHerdr } from './herdr.mjs';
import { acquireSourceLock } from './lock.mjs';
import { forkNative } from './native-fork.mjs';

export const SAFETY_NOTE = 'Herdr idle/done is screen-derived, not proof that all background work or approvals have completed. Forks share files and cwd, not isolated worktrees. Saved permissions and tool settings may follow the child; a conversation fork is not a security sandbox.';
const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const PANE_ID = /^w[0-9]+:p[0-9]+$/;
const WORKSPACE_ID = /^w[0-9]+$/;
const TAB_ID = /^w[0-9]+:t[0-9]+$/;

export function parseContext(env) {
  let context;
  try {
    context = JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON);
  } catch {
    throw new ForkError('invalid_context', 'Missing or malformed HERDR_PLUGIN_CONTEXT_JSON.');
  }
  if (!PANE_ID.test(context?.focused_pane_id ?? '')) {
    throw new ForkError('invalid_context', 'Plugin context must identify the focused source pane. HERDR_PANE_ID is not a source fallback.');
  }
  return context;
}

export function sourceFromPane(pane, paneId) {
  if (!pane || pane.pane_id !== paneId || !WORKSPACE_ID.test(pane.workspace_id ?? '') ||
      !TAB_ID.test(pane.tab_id ?? '') || typeof pane.terminal_id !== 'string' || !pane.terminal_id) {
    throw new ForkError('invalid_source', 'Herdr returned an invalid source pane.');
  }
  if (typeof pane.agent !== 'string' || pane.agent.toLowerCase() !== 'copilot') {
    throw new ForkError('not_copilot', 'The focused pane must contain a native Copilot agent.');
  }
  const session = pane.agent_session;
  if (session?.agent !== 'copilot' || session.kind !== 'id' || !SESSION_ID.test(session.value ?? '')) {
    throw new ForkError('missing_native_id', 'A native Copilot session ID from the Herdr integration hook is required.');
  }
  if (!['idle', 'done'].includes(pane.agent_status)) {
    throw new ForkError('source_not_idle', 'Source must be idle or done; working, blocked, and unknown sources are refused.');
  }
  const cwd = pane.foreground_cwd ?? pane.cwd;
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0')) {
    throw new ForkError('invalid_cwd', 'Source pane must expose an absolute valid cwd.');
  }
  return { paneId, terminalId: pane.terminal_id, workspaceId: pane.workspace_id,
    tabId: pane.tab_id, sourceId: session.value, cwd };
}

async function requireDirectory(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    throw new ForkError('invalid_directory', `${label} must be an absolute existing directory.`);
  }
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new ForkError('invalid_directory', `${label} must be an absolute existing directory.`);
  }
  if (!info.isDirectory()) throw new ForkError('invalid_directory', `${label} is not a directory.`);
}

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export async function selectLaunchers(env, resolveRuntime = realpath) {
  const legacy = env.HERDR_COPILOT_FORK_CLI;
  const helper = env.HERDR_COPILOT_FORK_HELPER_CLI;
  if (legacy !== undefined && helper !== undefined) {
    throw new ForkError('ambiguous_runtime',
      'Set only HERDR_COPILOT_FORK_HELPER_CLI or legacy HERDR_COPILOT_FORK_CLI, not both.');
  }
  const setting = legacy !== undefined ? 'HERDR_COPILOT_FORK_CLI' : 'HERDR_COPILOT_FORK_HELPER_CLI';
  const path = legacy !== undefined ? legacy : helper !== undefined ? helper :
    fileURLToPath(new URL('../node_modules/.bin/copilot', import.meta.url));
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    throw new ForkError('invalid_runtime', `${setting} must be an absolute existing helper executable path.`);
  }
  let helperPath;
  try {
    helperPath = await resolveRuntime(path);
  } catch {
    throw new ForkError('invalid_runtime', 'Could not resolve the selected helper executable. No fallback was attempted.');
  }
  if (typeof helperPath !== 'string' || !isAbsolute(helperPath) || helperPath.includes('\0')) {
    throw new ForkError('invalid_runtime', 'Resolved helper executable must be an absolute valid path.');
  }
  return {
    policy: legacy !== undefined ? 'legacy-paired' : 'system-shell',
    helperPath,
    interactiveCommand: legacy !== undefined ? helperPath : 'copilot',
    compatibility: 'unqualified',
  };
}

export function childCommand(childSessionId, copilotHome, launcher = 'copilot') {
  if (launcher === 'copilot') {
    // Keep the command word unquoted so the pane shell can expand its alias.
    return `COPILOT_HOME=${shellQuote(copilotHome)} copilot ${shellQuote(`--resume=${childSessionId}`)}`;
  }
  return ['/usr/bin/env', `COPILOT_HOME=${copilotHome}`, launcher, '--no-auto-update',
    `--resume=${childSessionId}`].map(shellQuote).join(' ');
}

export function resumeCommand(childSessionId, copilotHome, cwd, launcher = 'copilot') {
  return `cd ${shellQuote(cwd)} && ${childCommand(childSessionId, copilotHome, launcher)}`;
}

export async function runFork(mode, {
  env = process.env,
  herdr = undefined,
  nativeFork = forkNative,
  lock = acquireSourceLock,
  checkDirectory = requireDirectory,
  resolveRuntime = realpath,
  makeName = () => `cf-${randomBytes(8).toString('hex')}`,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  hookAttempts = 80,
  hookIntervalMs = 500,
  hookDeadlineMs = 40_000,
} = {}) {
  if (!['right', 'down', 'tab'].includes(mode)) throw new ForkError('invalid_mode', 'Expected right, down, or tab.');
  if (!['linux', 'darwin'].includes(process.platform)) throw new ForkError('unsupported_platform', 'Only Linux/WSL and macOS are supported.');
  const context = parseContext(env);
  if (typeof env.HERDR_BIN_PATH !== 'string' || !isAbsolute(env.HERDR_BIN_PATH)) {
    throw new ForkError('invalid_herdr_binary', 'HERDR_BIN_PATH must be an absolute Herdr executable path.');
  }
  const call = herdr ?? createHerdr(env.HERDR_BIN_PATH, env);
  const copilotHome = env.COPILOT_HOME ?? join(homedir(), '.copilot');
  await checkDirectory(copilotHome, 'COPILOT_HOME');
  const launcher = await selectLaunchers(env, resolveRuntime);
  const runtimeBinary = launcher.helperPath;
  let source;
  let release;
  try {
    source = sourceFromPane((await call(['pane', 'get', context.focused_pane_id])).pane, context.focused_pane_id);
    await checkDirectory(source.cwd, 'Source cwd');
    release = await lock(env.HERDR_PLUGIN_STATE_DIR, source.sourceId, copilotHome);
  } catch (error) {
    const failure = error instanceof ForkError ? error :
      new ForkError('action_failed', 'Fork action failed; no operation was retried.');
    failure.launcher = launcher;
    throw failure;
  }
  let childSessionId;
  let paneId;
  let name;
  let result;
  let failure;
  const recheckSource = async () => {
    const current = sourceFromPane((await call(['pane', 'get', source.paneId])).pane, source.paneId);
    if (Object.keys(source).some((key) => source[key] !== current[key])) {
      throw new ForkError('source_changed', 'Source identity, location, or cwd changed; the action was stopped.');
    }
    await checkDirectory(current.cwd, 'Source cwd');
  };
  try {
    await recheckSource();
    childSessionId = await nativeFork({ sourceId: source.sourceId, cwd: source.cwd, copilotHome,
      runtimeBinary, env, beforeFork: recheckSource });
    if (!SESSION_ID.test(childSessionId ?? '') || childSessionId === source.sourceId) {
      childSessionId = undefined;
      throw new ForkError('invalid_child_id', 'Fork helper did not return a distinct valid child ID.');
    }
    await recheckSource();
    name = makeName();
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new ForkError('invalid_agent_name', 'Invalid generated agent name.');
    const creationArgs = mode === 'tab'
      ? ['tab', 'create', '--workspace', source.workspaceId, '--label', name]
      : ['pane', 'split', source.paneId, '--direction', mode];
    const creation = await call([...creationArgs, '--cwd', source.cwd,
      '--env', `COPILOT_HOME=${copilotHome}`, '--no-focus']);
    const target = mode === 'tab' ? creation.root_pane : creation.pane;
    if (!PANE_ID.test(target?.pane_id ?? '') || target.pane_id === source.paneId ||
        typeof target.terminal_id !== 'string' || !target.terminal_id ||
        target.workspace_id !== source.workspaceId ||
        !TAB_ID.test(target.tab_id ?? '') ||
        (mode !== 'tab' && target.tab_id !== source.tabId)) {
      throw new ForkError('invalid_target', 'Herdr returned an unexpected target pane. Nothing was closed.');
    }
    paneId = target.pane_id;
    await recheckSource();
    let notReady = false;
    try {
      await call(['pane', 'run', paneId, childCommand(childSessionId, copilotHome, launcher.interactiveCommand)],
        { allowEmptyResult: true });
    } catch (error) {
      if (error.code !== 'agent_not_ready') throw error;
      notReady = true;
    }
    let verified = false;
    let state;
    let copilotDetected = false;
    const hookDeadline = Date.now() + hookDeadlineMs;
    for (let attempt = 0; attempt < hookAttempts; attempt++) {
      const remaining = hookDeadline - Date.now();
      if (remaining <= 0) break;
      const child = (await call(['pane', 'get', paneId], { timeout: remaining })).pane;
      if (!child || child.pane_id !== paneId || child.workspace_id !== source.workspaceId ||
          child.terminal_id !== target.terminal_id || child.tab_id !== target.tab_id) {
        throw new ForkError('target_changed', 'Target pane changed; no further action was taken.');
      }
      state = child.agent_status;
      copilotDetected = typeof child.agent === 'string' && child.agent.toLowerCase() === 'copilot';
      if (child.agent_session) {
        if (typeof child.agent !== 'string' || child.agent.toLowerCase() !== 'copilot' ||
            child.agent_session.agent !== 'copilot' || child.agent_session.kind !== 'id' ||
            child.agent_session.value !== childSessionId) {
          throw new ForkError('hook_mismatch', 'Target hook does not match the forked child ID. Pane and sessions were preserved; no input or focus was sent.');
        }
        verified = true;
        break;
      }
      if (typeof child.agent === 'string' && child.agent.toLowerCase() !== 'copilot') {
        throw new ForkError('target_changed', 'A different agent appeared in the target pane; no further action was taken.');
      }
      if (copilotDetected && state === 'blocked') {
        notReady = true;
        break;
      }
      if (attempt + 1 < hookAttempts) await sleep(hookIntervalMs);
    }
    const identityPending = !verified && copilotDetected && ['idle', 'done'].includes(state);
    if (!verified && !notReady && !identityPending) {
      throw new ForkError('hook_unverified', 'Child identity was not verified before the deadline. The live pane and child were preserved; do not launch another resume.');
    }
    const ready = verified && !notReady && ['idle', 'done'].includes(state);
    if (verified) await call(['agent', 'rename', paneId, name]);
    if (ready) await call(['agent', 'focus', paneId]);
    const inspectCommand = ['/usr/bin/env',
      ...(env.HERDR_SOCKET_PATH ? [`HERDR_SOCKET_PATH=${env.HERDR_SOCKET_PATH}`] : []),
      env.HERDR_BIN_PATH, 'pane', 'get', paneId].map(shellQuote).join(' ');
    result = { status: ready ? 'ready' : state === 'blocked' ? 'waiting_for_user' :
      identityPending ? 'identity_pending' : 'needs-attention',
      childSessionId, paneId, inspectCommand, launcher,
      ...(verified ? { name } : {}),
      identityVerified: verified, state: state ?? 'unknown',
      resumeCommand: resumeCommand(childSessionId, copilotHome, source.cwd, launcher.interactiveCommand),
      warning: SAFETY_NOTE,
      ...(ready ? {} : { message: `${identityPending
        ? 'Copilot appears idle, but its native child identity is still unverified. The SessionStart hook may arrive only after user interaction; no prompt was sent to force it.'
        : 'Inspect the existing child pane and resolve any trust/approval prompt manually only if appropriate. Nothing was approved, retried, or closed.'
      } After any manual interaction, run inspectCommand and compare result.pane.agent_session (agent copilot, kind id, value childSessionId). Do not rerun the fork action or resume the child elsewhere while this pane is live.` }),
    };
  } catch (error) {
    failure = error instanceof ForkError ? error :
      new ForkError('action_failed', 'Fork action failed; no operation was retried.');
    const id = childSessionId ?? error.childSessionId;
    if (id && SESSION_ID.test(id) && id !== source.sourceId) {
      failure.childSessionId = id;
      failure.resumeCommand = resumeCommand(id, copilotHome, source.cwd, launcher.interactiveCommand);
      failure.recovery = paneId
        ? 'Child and pane were preserved. Inspect the existing pane first; never resume the child elsewhere while it is live.'
        : 'Child was preserved. Resume it only after confirming no live child pane already owns it.';
    }
    if (paneId) failure.paneId = paneId;
  } finally {
    try {
      await release();
    } catch {
      failure ??= new ForkError('lock_cleanup_failed', 'Could not remove the owned source lock. Inspect plugin state before retrying.');
      if (result) Object.assign(failure, { childSessionId, paneId, resumeCommand: result.resumeCommand });
      failure.lockCleanupFailed = true;
    }
  }
  if (failure) {
    failure.launcher = launcher;
    throw failure;
  }
  return result;
}
