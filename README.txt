Herdr Copilot Session Forking (experimental preview)
==================================================

Candidate 0.3.0 splits the pinned fork helper from the interactive launcher.
Four exact source/interactive CLI pairs passed bounded local Linux qualification
with helper 1.0.105 fixed. See runbooks/compatibility.txt for the matrix and
shell controls; this does not qualify arbitrary installations or wrappers.
No automatic version-compatibility gate or private-CLI fallback is implemented.

Fork an idle Copilot CLI conversation into another Herdr pane or tab, keeping
the original conversation open. This is a Herdr plugin that uses Copilot CLI's
session-forking API, NOT a fork or replacement of Copilot CLI.
This preview has not yet been published to GitHub or the Herdr marketplace.
The intended repository is tesseracode/herdr-copilot-session-forking.

Actions
-------

  fork-right    Fork into a pane on the right.
  fork-down     Fork into a pane below.
  fork-tab      Fork into a new tab in the source workspace.

Plugin ID: tesseracode.copilot-session-forking

The action reads the focused pane's native session ID, asks a temporary Copilot
SDK runtime to fork its persisted history, shuts that helper down, and resumes
the distinct child in a new terminal. It never resumes or closes the source.

Requirements
------------

- Linux/WSL or macOS; native Windows is not supported by this preview.
- Herdr with plugin support; local integration exercised on 0.9.5.
- Node ^20.19.0 or >=22.12.0, plus npm.
- Installed Herdr Copilot identity integration and a source pane reporting a
  native Copilot session ID.
- The source and helper must use the same OS environment and Copilot home.
  Default: ~/.copilot; a custom COPILOT_HOME requires explicit operator review.
- Existing Copilot authentication. No credentials are included in this project.
- A working shell-native `copilot --resume=<id>` in Herdr's pane shell,
  including any local functions, aliases, and launch policies.

The package pins SDK 1.0.28 and a project-local helper CLI 1.0.105. It does not update
your globally installed CLI or another application's embedded Copilot runtime.
Candidate 0.3.0 retains the override of only SDK 1.0.28's Zod dependency to 4.6.6 to address
GHSA-mrhx-c7xc-m3w5. This is outside the SDK's exact dependency pin, not an
upstream SDK fix. Keep the override explicit when installing with npm ci.
The default-policy evidence is recorded separately from earlier paired-launcher
results in runbooks/compatibility.txt.
macOS is declared in the manifest but remains unqualified.

Launcher policy and settings
---------------------------

By default, the helper uses the resolved absolute project-local CLI path.
Child launch and every suggested recovery command instead use the pane shell:

  COPILOT_HOME='/absolute/copilot-home' copilot '--resume=<child-id>'

Recovery prefixes this with a safely quoted `cd` to the source cwd. The command
word `copilot` remains unquoted for shell alias expansion; shell functions and
local launch policy also apply. COPILOT_HOME is quoted as an assignment, not
passed through `env`, so it does not bypass shell functions. No private CLI
directory is prepended to PATH, and no --no-auto-update flag is added in this
default policy. Herdr restoration likewise uses shell-native
`copilot --resume=<id>`; it does not preserve a one-off absolute launcher or flags.

Settings are read from the plugin action's environment:

- HERDR_COPILOT_FORK_HELPER_CLI: optional absolute helper executable override.
  Only the helper changes; interactive launch and recovery stay shell-native.
- HERDR_COPILOT_FORK_CLI: legacy paired mode. An explicit absolute executable
  override selects the resolved path for helper, interactive child, and recovery.
  This preserves the former explicit-launch behavior, including `env` and
  --no-auto-update for interactive launch. It bypasses shell functions/aliases
  during initial launch and recovery; Herdr restoration still uses its own
  canonical shell launcher, not this override.

Do not set both variables. Any simultaneous presence (even an empty value) is
rejected as ambiguous_runtime. Empty, relative, malformed, or unresolvable paths
are rejected as invalid_runtime. There is no automatic private-runtime fallback
when the shell launcher is unavailable or refuses a policy check.

Action results and post-selection recovery errors include `launcher` metadata:
`policy` (system-shell or legacy-paired), `helperPath` (resolved absolute path),
`interactiveCommand` (copilot or the legacy resolved path), and
`compatibility` (unqualified). These describe configuration, not detected runtime
versions. A shell function may choose a different executable; no actual helper
or interactive runtime version is claimed to have been detected. The unqualified
field means the action has not matched actual runtimes to the recorded matrix;
it does not negate the bounded matrix evidence. All custom launcher combinations
also require disposable-session qualification.

Safety boundaries
-----------------

Use disposable conversations first. A source must be idle/done; screen-derived
state is not proof that background work or pending approvals have settled.
Confirm that yourself before invoking an action. Forking mid-turn is not a
supported preview workflow.

A fork separates conversation history, NOT files. Both agents share the source
working directory. Use read-only tasks unless you deliberately coordinate edits.

The fork captures persisted history, not a live process clone. Running tools,
subagents, approvals, ephemeral CLI options, and environment overrides are not
promised to transfer. In particular, do not assume a source launched with a
one-off tool restriction makes its child equally restricted.

The plugin does not approve folder trust, tools, or any other dialog. A child
may stop at folder trust; inspect it manually. Missing child identity is not a
verified successful handoff. Do not fork again to recover a startup dialog.
An attention notification identifies the child pane when handoff is pending.
Read the action's JSON status in the plugin log: Herdr's outer "succeeded"
means the command exited cleanly, NOT that identity was confirmed.

Very narrow panes can show an unrecognized trust dialog while Herdr reports
idle. That case is explicitly returned as identity_pending, not ready. Inspect
the actual terminal before interacting. The plugin never sends a prompt to
force the identity hook, which may arrive only on your first child turn.

Unsupported APIs, duplicate invocations, busy sources, identity mismatches, and
uncertain helper termination fail closed. No file copying, manual lock release,
or fallback to resuming the source is used.

Local development
-----------------

  npm ci --no-audit --no-fund
  npm test
  herdr plugin link /absolute/path/to/herdr-copilot-session-forking

No keybindings are installed automatically. See runbooks/install.txt and
runbooks/test.txt before enabling this on a machine with important work.
Review the launcher settings before linking. Unit tests do not establish native
session compatibility; runbooks/compatibility.txt records this candidate's exact
live matrix and limits, and runbooks/qualification.txt retains the history.

After the disposable pass, you can choose an unused shortcut in Herdr's own
config.toml. Back up the config and check existing bindings first. Example:

  [[keys.command]]
  key = "prefix+alt+f"
  type = "plugin_action"
  command = "tesseracode.copilot-session-forking.fork-right"
  description = "fork Copilot beside this pane"

Use fork-tab instead for a new tab. Apply the config through your compatible
server's supported reload-config command; never restart an important server
to apply a shortcut. This example is not installed by the plugin.

The optional scripts/native-spike.mjs makes short model calls in disposable
sessions using your existing account. It is not part of npm test and is not
run by plugin actions. scripts/check-history.mjs checks marker isolation using
the SDK's read-only persisted-history API; it does not resume either session.

Source packaging and privacy
----------------------------

  npm run pack:source

The source packager requires GNU tar and writes a new .tar.gz plus SHA-256
checksum into dist/. It refuses to overwrite an existing version's output.
It packages only the explicit file allowlist in package.json plus package.json
and .gitignore, with numeric archive ownership rather than local account names.
It includes package-lock.json so consumers can use npm ci. npm pack is NOT the
source-release command: npm omits package-lock.json from its packages.
Dependencies, local logs, test state and session data are not release inputs.

Inspect the archive listing and selected file contents before publishing.
An allowlist limits which files ship; it does not detect secrets inside them.
Keep "private": true to prevent accidental npm publication. It does not prevent
GitHub disclosure. Git ignore rules are also not a substitute for reviewing the
files staged for a first public commit. Do not commit generated release bundles.

Runtime action logs contain local paths, session IDs and recovery commands.
Do not upload those logs without redaction. Stopping a disposable Herdr lab
does not promise to erase its logs or the saved Copilot conversation history.

The 0.2.0 preview changes the plugin identity from the private prototype.
Keep that prototype's installation separate. Do not relink an existing
installation while an action is running. Disable the old plugin registration
before enabling the new one; do not copy credentials, delete history, or
restart important sessions as part of the migration.

Research and license
--------------------

The official SDK fork API is experimental; compatibility with other CLI/SDK
versions is not promised.

  External CLI fork request:
  https://github.com/github/copilot-cli/issues/4580

  Official native fork independence test:
  https://github.com/github/copilot-sdk/blob/712085fcbe0c3bdf7038a5c9f0aaf32300a81575/nodejs/test/e2e/rpc_session_state.e2e.test.ts#L148-L192

This plugin does not implement live-session attachment or shared control.
Plugin-owned code is licensed under MIT; see LICENSE. Dependencies retain their
own licenses. This community plugin is not an official GitHub Copilot product.
