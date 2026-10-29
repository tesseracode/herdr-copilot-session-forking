import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runFork, parseContext, sourceFromPane, resumeCommand, childCommand, selectLaunchers } from '../src/fork.mjs';
import { ForkError } from '../src/errors.mjs';

const source = {
  pane_id: 'w1:p1', terminal_id: 'term-1', workspace_id: 'w1', tab_id: 'w1:t1',
  agent: 'Copilot', agent_status: 'idle', cwd: '/shell', foreground_cwd: '/project',
  agent_session: { agent: 'copilot', kind: 'id', value: 'source-session' },
};
const child = {
  ...source, pane_id: 'w1:p2', terminal_id: 'term-2',
  agent_session: { agent: 'copilot', kind: 'id', value: 'child-session' },
};

function fixture(overrides = {}) {
  const events = [];
  let sourceReads = 0;
  const options = {
    env: {
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: source.pane_id }),
      HERDR_PANE_ID: 'w9:p9',
      HERDR_BIN_PATH: '/usr/bin/herdr',
      HERDR_PLUGIN_STATE_DIR: '/plugin-state',
      COPILOT_HOME: '/copilot-home',
      PATH: '/user/bin:/usr/bin:/bin',
    },
    checkDirectory: async (path, label) => { events.push(['directory', path, label]); },
    resolveRuntime: async (path) => path,
    makeName: () => 'cf-test',
    hookAttempts: 2,
    hookIntervalMs: 1,
    sleep: async () => { events.push(['sleep']); },
    lock: async (...args) => {
      events.push(['lock', ...args]);
      return async () => { events.push(['unlock']); };
    },
    nativeFork: async (config) => {
      events.push(['native', config]);
      await config.beforeFork();
      events.push(['helper-stopped']);
      return 'child-session';
    },
    herdr: async (args) => {
      events.push(args);
      if (args[0] === 'pane' && args[1] === 'get') {
        if (args[2] === source.pane_id) {
          sourceReads++;
          return { pane: structuredClone(source) };
        }
        const inTab = events.some((event) => event[0] === 'tab' && event[1] === 'create');
        return { pane: { ...structuredClone(child), tab_id: inTab ? 'w1:t2' : 'w1:t1' } };
      }
      if (args[0] === 'pane' && args[1] === 'split') return { pane: structuredClone(child) };
      if (args[0] === 'tab' && args[1] === 'create') {
        return { root_pane: { ...child, tab_id: 'w1:t2' }, tab: { tab_id: 'w1:t2' } };
      }
      return {};
    },
    ...overrides,
  };
  return { options, events, sourceReads: () => sourceReads };
}

for (const value of [undefined, '', '{', 'null', '[]', '{}',
  '{"focused_pane_id":"--current"}', '{"focused_pane_id":"w1:p1;bad"}']) {
  test(`reject context ${String(value)}`, () => {
    assert.throws(() => parseContext({ HERDR_PLUGIN_CONTEXT_JSON: value, HERDR_PANE_ID: 'w1:p1' }),
      { code: 'invalid_context' });
  });
}

test('never substitutes plugin HERDR_PANE_ID for focused source', () => {
  const context = parseContext({ HERDR_PLUGIN_CONTEXT_JSON: '{"focused_pane_id":"w1:p1"}',
    HERDR_PANE_ID: 'w2:p2' });
  assert.equal(context.focused_pane_id, source.pane_id);
});

for (const [label, patch, code] of [
  ['nonCopilot', { agent: 'claude' }, 'not_copilot'],
  ['no agent', { agent: null }, 'not_copilot'],
  ['no native ID', { agent_session: null }, 'missing_native_id'],
  ['path ID', { agent_session: { agent: 'copilot', kind: 'path', value: '/session' } }, 'missing_native_id'],
  ['wrong native agent', { agent_session: { agent: 'codex', kind: 'id', value: 'source-session' } }, 'missing_native_id'],
  ['unsafe native ID', { agent_session: { agent: 'copilot', kind: 'id', value: '--all' } }, 'missing_native_id'],
  ...['working', 'blocked', 'unknown', undefined].map((state) => [
    `state ${state}`, { agent_status: state }, 'source_not_idle',
  ]),
  ['relative cwd', { foreground_cwd: 'relative' }, 'invalid_cwd'],
  ['no cwd', { cwd: null, foreground_cwd: null }, 'invalid_cwd'],
  ['wrong pane', { pane_id: 'w1:p9' }, 'invalid_source'],
]) {
  test(`reject source ${label}`, () => {
    assert.throws(() => sourceFromPane({ ...source, ...patch }, source.pane_id), { code });
  });
}

test('foreground cwd wins and done is permitted', () => {
  assert.equal(sourceFromPane({ ...source, agent_status: 'done' }, source.pane_id).cwd, '/project');
  assert.equal(sourceFromPane({ ...source, foreground_cwd: null }, source.pane_id).cwd, '/shell');
});

for (const mode of ['right', 'down', 'tab']) {
  test(`fork ${mode} targets source, preserves cwd and verifies before focus`, async () => {
    const f = fixture();
    const result = await runFork(mode, f.options);
    assert.equal(result.status, 'ready');
    assert.equal(result.identityVerified, true);
    assert.equal(result.childSessionId, 'child-session');
    assert.equal(f.sourceReads(), 5);
    assert.equal(f.events.at(-1)[0], 'unlock');
    const creation = f.events.find((event) => ['split', 'create'].includes(event[1]));
    assert.ok(creation.includes('--no-focus'));
    assert.deepEqual(creation.slice(-5), ['--cwd', '/project',
      '--env', 'COPILOT_HOME=/copilot-home', '--no-focus']);
    assert.ok(!creation.some((arg) => arg.startsWith('PATH=')));
    assert.equal(f.options.env.PATH, '/user/bin:/usr/bin:/bin');
    if (mode === 'tab') assert.deepEqual(creation.slice(0, 4), ['tab', 'create', '--workspace', 'w1']);
    else assert.deepEqual(creation.slice(0, 5), ['pane', 'split', 'w1:p1', '--direction', mode]);
    const native = f.events.find((event) => event[0] === 'native')[1];
    assert.equal(native.sourceId, 'source-session');
    assert.equal(native.cwd, '/project');
    assert.equal(native.copilotHome, '/copilot-home');
    assert.equal(native.runtimeBinary, fileURLToPath(new URL('../node_modules/.bin/copilot', import.meta.url)));
    assert.deepEqual(result.launcher, { policy: 'system-shell', helperPath: native.runtimeBinary,
      interactiveCommand: 'copilot', compatibility: 'unqualified' });
    const startIndex = f.events.findIndex((event) => event[1] === 'run');
    assert.ok(f.events.findIndex((event) => event[0] === 'helper-stopped') < startIndex);
    assert.deepEqual(f.events[startIndex], ['pane', 'run', 'w1:p2',
      childCommand('child-session', '/copilot-home')]);
    assert.equal(result.resumeCommand, resumeCommand('child-session', '/copilot-home', '/project'));
    assert.ok(f.events.some((event) => event[0] === 'agent' && event[1] === 'rename' &&
      event[2] === 'w1:p2' && event[3] === 'cf-test'));
    const focusIndex = f.events.findIndex((event) => event[1] === 'focus');
    assert.ok(f.events.findIndex((event) => event[1] === 'get' && event[2] === 'w1:p2') < focusIndex);
    assert.match(result.warning, /screen-derived/);
    assert.match(result.warning, /permissions and tool settings/);
    assert.match(result.warning, /not a security sandbox/);
  });
}

test('same ID from native helper never launches or suggests source resume', async () => {
  const f = fixture({ nativeFork: async () => 'source-session' });
  await assert.rejects(runFork('right', f.options), (error) => {
    assert.equal(error.code, 'invalid_child_id');
    assert.equal(error.resumeCommand, undefined);
    return true;
  });
  assert.ok(!f.events.some((event) => event[1] === 'split'));
  assert.equal(f.events.at(-1)[0], 'unlock');
});

test('helper failure carries child recovery and never launches', async () => {
  const f = fixture({ nativeFork: async () => {
    throw new ForkError('helper_stop_failed', 'Stop failed', { childSessionId: 'child-session' });
  } });
  await assert.rejects(runFork('right', f.options), (error) => {
    assert.equal(error.childSessionId, 'child-session');
    assert.match(error.resumeCommand, /--resume=child-session/);
    return true;
  });
  assert.ok(!f.events.some((event) => event[1] === 'split'));
  assert.equal(f.events.at(-1)[0], 'unlock');
});

test('launch failure preserves pane and child; no duplicate launch or close', async () => {
  const f = fixture();
  const original = f.options.herdr;
  f.options.herdr = async (args) => {
    if (args[1] === 'run') {
      f.events.push(args);
      throw new ForkError('herdr_timeout', 'Uncertain start');
    }
    return original(args);
  };
  await assert.rejects(runFork('right', f.options), (error) => {
    assert.equal(error.childSessionId, 'child-session');
    assert.equal(error.paneId, 'w1:p2');
    assert.match(error.recovery, /never resume/);
    return true;
  });
  assert.equal(f.events.filter((event) => event[1] === 'run').length, 1);
  assert.ok(!f.events.some((event) => ['close', 'focus'].includes(event[1])));
});

for (const hookPresent of [true, false]) {
  test(`agent_not_ready preserves live pane, hook ${hookPresent}`, async () => {
    const f = fixture();
    const original = f.options.herdr;
    f.options.herdr = async (args) => {
      if (args[1] === 'run') {
        f.events.push(args);
        throw new ForkError('agent_not_ready', 'Trust prompt');
      }
      if (args[1] === 'get' && args[2] === child.pane_id) {
        f.events.push(args);
        return { pane: { ...child, agent_status: 'blocked',
          agent_session: hookPresent ? child.agent_session : null } };
      }
      return original(args);
    };
    const result = await runFork('down', f.options);
    assert.equal(result.status, 'waiting_for_user');
    assert.equal(result.identityVerified, hookPresent);
    assert.equal(f.events.filter((event) => event[1] === 'run').length, 1);
    assert.ok(!f.events.some((event) => ['close', 'focus', 'send-keys', 'prompt'].includes(event[1])));
  });
}

for (const [label, session, expectedCode] of [
  ['mismatch', { agent: 'copilot', kind: 'id', value: 'source-session' }, 'hook_mismatch'],
  ['wrong agent', { agent: 'codex', kind: 'id', value: 'child-session' }, 'hook_mismatch'],
]) {
  test(`hook ${label} fails closed`, async () => {
    const f = fixture();
    const original = f.options.herdr;
    f.options.herdr = async (args) => args[1] === 'get' && args[2] === child.pane_id
      ? { pane: { ...child, agent_session: session } } : original(args);
    await assert.rejects(runFork('right', f.options), { code: expectedCode,
      childSessionId: 'child-session', paneId: 'w1:p2' });
    assert.ok(!f.events.some((event) => ['close', 'focus'].includes(event[1])));
  });
}

test('idle Copilot without a hook returns identity pending, never verified success or an automatic prompt', async () => {
  const f = fixture();
  const original = f.options.herdr;
  f.options.herdr = async (args) => args[1] === 'get' && args[2] === child.pane_id
    ? { pane: { ...child, agent_session: null } } : original(args);
  const result = await runFork('right', f.options);
  assert.equal(result.status, 'identity_pending');
  assert.equal(result.identityVerified, false);
  assert.equal(result.name, undefined);
  assert.match(result.message, /no prompt was sent to force it/);
  assert.ok(!f.events.some((event) => ['rename', 'focus', 'send-keys', 'prompt', 'close'].includes(event[1])));
});

test('no detected agent or hook still fails closed', async () => {
  const f = fixture();
  const original = f.options.herdr;
  f.options.herdr = async (args) => args[1] === 'get' && args[2] === child.pane_id
    ? { pane: { ...child, agent: null, agent_session: null, agent_status: 'unknown' } } : original(args);
  await assert.rejects(runFork('right', f.options), { code: 'hook_unverified',
    childSessionId: 'child-session', paneId: 'w1:p2' });
  assert.ok(!f.events.some((event) => ['close', 'focus'].includes(event[1])));
});

test('source identity is rechecked after fork and preserves child on change', async () => {
  const f = fixture();
  const original = f.options.herdr;
  f.options.herdr = async (args) => {
    if (args[1] === 'get' && args[2] === source.pane_id && f.sourceReads() >= 3) {
      return { pane: { ...source, agent_session: { ...source.agent_session, value: 'another-session' } } };
    }
    return original(args);
  };
  await assert.rejects(runFork('right', f.options), { code: 'source_changed', childSessionId: 'child-session' });
  assert.ok(!f.events.some((event) => event[1] === 'split'));
});

test('source becoming busy before launch refuses start and preserves pane', async () => {
  const f = fixture();
  const original = f.options.herdr;
  f.options.herdr = async (args) => {
    if (args[1] === 'get' && args[2] === source.pane_id && f.sourceReads() >= 4) {
      return { pane: { ...source, agent_status: 'working' } };
    }
    return original(args);
  };
  await assert.rejects(runFork('right', f.options), { code: 'source_not_idle',
    childSessionId: 'child-session', paneId: 'w1:p2' });
  assert.ok(!f.events.some((event) => event[1] === 'run'));
});

test('creation failure preserves fork without retry', async () => {
  const f = fixture();
  const original = f.options.herdr;
  f.options.herdr = async (args) => {
    if (args[1] === 'split') throw new ForkError('herdr_timeout', 'Uncertain split');
    return original(args);
  };
  await assert.rejects(runFork('right', f.options), (error) => {
    assert.equal(error.childSessionId, 'child-session');
    assert.match(error.resumeCommand, /COPILOT_HOME='\/copilot-home' copilot/);
    assert.match(error.recovery, /confirming no live child pane/);
    return true;
  });
});

test('locked duplicate never invokes fork or alters layout', async () => {
  let forked = false;
  const f = fixture({
    lock: async () => { throw new ForkError('source_locked', 'Already locked'); },
    nativeFork: async () => { forked = true; },
  });
  await assert.rejects(runFork('right', f.options), { code: 'source_locked' });
  assert.equal(forked, false);
  assert.ok(!f.events.some((event) => event[1] === 'split'));
});

test('target from another workspace is never launched', async () => {
  const f = fixture();
  const original = f.options.herdr;
  f.options.herdr = async (args) => args[1] === 'create'
    ? { root_pane: { ...child, workspace_id: 'w2' } } : original(args);
  await assert.rejects(runFork('tab', f.options), { code: 'invalid_target', childSessionId: 'child-session' });
  assert.ok(!f.events.some((event) => event[1] === 'run'));
});

test('private home and runtime overrides must be absolute', async () => {
  const f = fixture();
  f.options.env.HERDR_COPILOT_FORK_CLI = './copilot';
  await assert.rejects(runFork('right', f.options), { code: 'invalid_runtime' });
});

test('helper, child, and recovery use the same explicitly selected runtime', async () => {
  const f = fixture();
  f.options.env.HERDR_COPILOT_FORK_CLI = '/selected/bin/copilot';
  f.options.resolveRuntime = async () => '/selected/lib/copilot.js';
  const result = await runFork('right', f.options);
  const native = f.events.find((event) => event[0] === 'native')[1];
  assert.equal(native.runtimeBinary, '/selected/lib/copilot.js');
  assert.equal(f.events.find((event) => event[1] === 'run')[3],
    childCommand('child-session', '/copilot-home', native.runtimeBinary));
  assert.match(result.resumeCommand, /'\/selected\/lib\/copilot.js'/);
  assert.equal(result.launcher.policy, 'legacy-paired');
});

test('recovery command shell-quotes cwd, home, and child', () => {
  assert.equal(resumeCommand('child-session', "/home/it's", "/repo/it's", "/bin/it's/copilot"),
    "cd '/repo/it'\\''s' && '/usr/bin/env' 'COPILOT_HOME=/home/it'\\''s' '/bin/it'\\''s/copilot' '--no-auto-update' '--resume=child-session'");
});

test('explicit launch bypasses canonical copilot functions without shell expansion', () => {
  const home = "/home/it's $(printf unintended)";
  const launcher = "/project/it's copilot/copilot";
  const command = childCommand('child-session', home, launcher);
  const parsed = spawnSync('/bin/sh', ['-c', `set -- ${command}; printf '%s\\000' "$@"`],
    { encoding: 'utf8' });
  assert.equal(parsed.status, 0);
  assert.deepEqual(parsed.stdout.split('\0').slice(0, -1), [
    '/usr/bin/env', `COPILOT_HOME=${home}`, launcher, '--no-auto-update', '--resume=child-session',
  ]);
});

test('default child and recovery preserve shell functions, home, quoting and PATH', () => {
  const home = "/home/it's $(printf unintended); space";
  assert.equal(childCommand('child-session', home),
    "COPILOT_HOME='/home/it'\\''s $(printf unintended); space' copilot '--resume=child-session'");
  assert.equal(resumeCommand('child-session', home, "/repo/it's"),
    `cd '/repo/it'\\''s' && ${childCommand('child-session', home)}`);
  for (const command of [childCommand('child-session', home), resumeCommand('child-session', home, '/')]) {
    const script = `copilot() { printf '%s\\000' "$COPILOT_HOME" "$PATH" "$@"; }\n${command}`;
    const result = spawnSync('/bin/sh', ['-c', script], {
      encoding: 'utf8', env: { PATH: '/user/bin:/usr/bin:/bin' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.split('\0').slice(0, -1), [
      home, '/user/bin:/usr/bin:/bin', '--resume=child-session',
    ]);
  }
});

test('default command word permits shell alias expansion', () => {
  const script = `alias copilot='printf "%s\\\\n" alias-used'\n${childCommand('child-session', '/copilot-home')}`;
  const result = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'alias-used\n--resume=child-session\n');
});

for (const setting of ['HERDR_COPILOT_FORK_CLI', 'HERDR_COPILOT_FORK_HELPER_CLI']) {
  for (const value of ['', './copilot', 'copilot', '/bad\0path', null, 42]) {
    test(`reject invalid ${setting} ${JSON.stringify(value)} before helper or layout`, async () => {
      const f = fixture();
      f.options.env[setting] = value;
      await assert.rejects(runFork('right', f.options), { code: 'invalid_runtime' });
      assert.ok(!f.events.some((event) => ['native', 'lock'].includes(event[0]) ||
        ['split', 'create', 'run'].includes(event[1])));
    });
  }
}

test('helper-only selection does not change interactive or recovery policy', async () => {
  const f = fixture();
  f.options.env.HERDR_COPILOT_FORK_HELPER_CLI = '/helper/bin/copilot';
  f.options.resolveRuntime = async () => '/helper/lib/copilot.js';
  const result = await runFork('right', f.options);
  assert.equal(f.events.find((event) => event[0] === 'native')[1].runtimeBinary, '/helper/lib/copilot.js');
  assert.equal(f.events.find((event) => event[1] === 'run')[3],
    childCommand('child-session', '/copilot-home'));
  assert.equal(result.resumeCommand, resumeCommand('child-session', '/copilot-home', '/project'));
  assert.deepEqual(result.launcher, { policy: 'system-shell', helperPath: '/helper/lib/copilot.js',
    interactiveCommand: 'copilot', compatibility: 'unqualified' });
});

for (const helper of ['/helper/copilot', '']) {
  test(`paired and helper overrides are ambiguous even with helper ${JSON.stringify(helper)}`, async () => {
    const f = fixture();
    f.options.env.HERDR_COPILOT_FORK_CLI = '/legacy/copilot';
    f.options.env.HERDR_COPILOT_FORK_HELPER_CLI = helper;
    await assert.rejects(runFork('right', f.options), { code: 'ambiguous_runtime' });
    assert.equal(f.events.length, 1);
  });
}

test('missing helper and invalid resolved helper fail without fallback', async () => {
  for (const resolver of [async () => { throw new Error('missing'); }, async () => 'relative']) {
    await assert.rejects(selectLaunchers({}, resolver), { code: 'invalid_runtime' });
  }
});

for (const policy of ['default', 'helper-only', 'legacy-paired']) {
  for (const phase of ['lock', 'helper', 'helper-no-child', 'invalid-child', 'source-change', 'create', 'invalid-target',
    'before-launch', 'launch', 'hook', 'mismatch', 'target-change', 'rename', 'focus', 'unlock',
    'blocked', 'not-ready', 'pending', 'working']) {
    test(`${policy} keeps selected launcher on ${phase} result/recovery`, async () => {
      const f = fixture();
      if (policy !== 'default') {
        f.options.env[policy === 'helper-only' ? 'HERDR_COPILOT_FORK_HELPER_CLI' :
          'HERDR_COPILOT_FORK_CLI'] = "/selected/it's copilot";
      }
      const command = policy === 'legacy-paired' ? "/selected/it's copilot" : 'copilot';
      const expected = resumeCommand('child-session', '/copilot-home', '/project', command);
      const fail = () => { throw new ForkError('test_failure', 'Synthetic failure'); };
      if (phase === 'helper') f.options.nativeFork = async () => {
        throw new ForkError('helper_cleanup_failed', 'Synthetic cleanup', { childSessionId: 'child-session' });
      };
      if (phase === 'helper-no-child') f.options.nativeFork = async () => {
        throw new ForkError('fork_uncertain', 'Synthetic uncertain fork');
      };
      if (phase === 'invalid-child') f.options.nativeFork = async () => 'source-session';
      if (phase === 'lock') f.options.lock = async () => {
        throw new ForkError('source_locked', 'Synthetic lock refusal');
      };
      if (phase === 'unlock') f.options.lock = async () => fail;
      const original = f.options.herdr;
      f.options.herdr = async (args) => {
        if (phase === 'not-ready' && args[1] === 'run') {
          f.events.push(args);
          throw new ForkError('agent_not_ready', 'Synthetic trust prompt');
        }
        if (phase === 'source-change' && args[1] === 'get' && args[2] === source.pane_id &&
            f.sourceReads() >= 3) return { pane: { ...source, foreground_cwd: '/changed' } };
        if (phase === 'before-launch' && args[1] === 'get' && args[2] === source.pane_id &&
            f.sourceReads() >= 4) return { pane: { ...source, agent_status: 'working' } };
        if ((phase === 'create' && args[1] === 'split') ||
            (phase === 'launch' && args[1] === 'run') ||
            (phase === 'rename' && args[1] === 'rename') ||
            (phase === 'focus' && args[1] === 'focus')) {
          f.events.push(args);
          fail();
        }
        if (phase === 'invalid-target' && args[1] === 'split') {
          return { pane: { ...child, workspace_id: 'w9' } };
        }
        if (args[1] === 'get' && args[2] === child.pane_id) {
          if (phase === 'hook') return { pane: { ...child, agent: null, agent_session: null } };
          if (phase === 'mismatch') return { pane: { ...child, agent_session: source.agent_session } };
          if (phase === 'target-change') return { pane: { ...child, terminal_id: 'changed' } };
          if (['blocked', 'not-ready', 'pending'].includes(phase)) return { pane: { ...child,
            agent_session: null, agent_status: phase === 'pending' ? 'idle' : 'blocked' } };
          if (phase === 'working') return { pane: { ...child, agent_status: 'working' } };
        }
        return original(args);
      };
      let outcome;
      if (['blocked', 'not-ready', 'pending', 'working'].includes(phase)) {
        outcome = await runFork('right', f.options);
        assert.equal(outcome.status, { blocked: 'waiting_for_user', 'not-ready': 'waiting_for_user', pending: 'identity_pending',
          working: 'needs-attention' }[phase]);
      } else {
        await assert.rejects(runFork('right', f.options), (error) => { outcome = error; return true; });
      }
      assert.equal(outcome.launcher.policy, policy === 'legacy-paired' ? policy : 'system-shell');
      assert.equal(outcome.launcher.compatibility, 'unqualified');
      assert.equal(outcome.launcher.interactiveCommand, command);
      assert.equal(outcome.resumeCommand, ['lock', 'helper-no-child', 'invalid-child'].includes(phase) ? undefined : expected);
      for (const event of f.events.filter((event) => event[1] === 'run')) {
        assert.equal(event[3], childCommand('child-session', '/copilot-home', command));
      }
      assert.ok(!f.events.some((event) => event.some((arg) =>
        typeof arg === 'string' && arg.startsWith('PATH='))));
    });
  }
}

test('detected trust prompt before hook returns attention without claiming identity or focusing', async () => {
  const f = fixture();
  const original = f.options.herdr;
  f.options.herdr = async (args) => args[1] === 'get' && args[2] === child.pane_id
    ? { pane: { ...child, agent_status: 'blocked', agent_session: null } } : original(args);
  const result = await runFork('right', f.options);
  assert.equal(result.status, 'waiting_for_user');
  assert.equal(result.identityVerified, false);
  assert.equal(result.name, undefined);
  assert.match(result.message, /Do not rerun the fork action/);
  assert.match(result.inspectCommand, /'pane' 'get' 'w1:p2'/);
  assert.ok(!f.events.some((event) => ['rename', 'focus', 'send-keys', 'prompt', 'close'].includes(event[1])));
  assert.equal(f.events.filter((event) => event[1] === 'run').length, 1);
});
