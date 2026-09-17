# Remote workspaces (local Agent, SSH project execution)

Pi Web keeps the Agent, model authentication, global plugins, and global skills on
its host. Project tools and workspace terminals can run on an SSH destination.
This does **not** make arbitrary extension code, MCP servers, browsers, or
background-task plugins remote. Those tools must explicitly select their target.

## Connecting

Use the Remote panel with an SSH config alias or `user@host` and a project path.
An empty path resolves to the remote login home; `~` and `~/...` are supported.
Saving a connection resolves and validates the directory before changing the
selected workspace. No separate SSH extension is required in Pi Web.

The first implementation targets Linux/POSIX hosts with Bash and the utilities
used by the relevant feature: Git, GNU find/stat/readlink, base64, and remote
search utilities. Missing dependencies produce errors; Pi Web does not install
software on the remote host. `grep` requires remote `rg`. `find` uses remote
`fd` when available; its GNU `find` fallback supports basename patterns only
and does not apply `.gitignore`. The terminal uses the remote user's login shell.

SSH uses key/agent authentication (`BatchMode=yes`) and strict host-key checking.
Set up and verify the destination with the normal SSH client first. Pi Web never
auto-accepts an unknown host key or falls back to a local shell after an SSH error.
Pi Web does not copy model authentication files to the remote host. Custom SSH
`SendEnv`/`SetEnv` settings remain the user's responsibility.

## Stable identity and compatibility

Each connected project gets an immutable host/path binding under
`~/.pi/agent/remote-workspaces/`. Existing local cwd/session formats are retained:
`~/.pi/remote/<host>_<hash>/` is only a compatibility key, not the project filesystem.
File browsing, Git, Agent tools, child sessions, and terminals resolve that saved
binding instead of reading the current global SSH selection on every operation.

Changing the selected connection or returning to local mode does not move or
terminate existing remote sessions or terminals. A terminal restart uses the
original target. Unknown old cache directories fail closed with a reconnect
message, rather than becoming writable local projects. Old metadata cannot be
reconstructed from a path hash alone; reconnect the intended project explicitly.

## Tools and resources

- `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls` are bound to the remote
  project. POSIX paths are resolved independently of the host OS. Windows
  PowerShell preferences do not cause project commands to run on the local PC.
  File/search SSH calls have a 30-second timeout; writes have a 300-second limit.
  Bash retains its explicit tool timeout policy. Transport output is capped at
  16 MiB per invocation, before the tool's usual result truncation.
- Built-in subagents inherit the target even with optional extensions disabled.
  Their configured tool allowlist remains in force. Input attachments are read
  from the remote project with file-count, byte, UTF-8, and path-boundary checks.
- Local/global skills and plugins remain local. Read-only access to registered
  local resource documents is distinct from reading project files; remote
  failures do not trigger a local read fallback.
- Remote `AGENTS.override.md`, `AGENTS.md`, or `CLAUDE.md` context is read as text
  from the project and its ancestors when a main session runtime is created.
  No remote `.pi`/`.agents` archive is extracted locally. Old cache settings,
  extensions, packages, and project agent profiles are not loaded. Remote
  sessions currently use global/built-in agent profiles.
- Pi Web excludes its legacy SSH package from session resource discovery without
  removing it from the user's installation. Its CLI usage is not migrated.

## Workspace terminal

The existing xterm interface, tabs, SSE output, input queue, resizing, bounded
replay, and reconnect lease are reused. Only process creation changes: local
workspaces start the normal host shell; SSH workspaces start `ssh -tt` in the PTY
(`ssh.exe` on Windows, required by ConPTY) and `cd` to their saved remote cwd
before starting an interactive shell.

Terminal headers show `SSH · host:path`. Restoring a tab only attaches to its
existing terminal ID; it never silently starts a replacement process. The
server validates the target snapshot for creation/reuse, and the client checks
it on reconnect. A failed `cd` or SSH connection exits; it cannot open a local
shell as a fallback.

Closing a terminal terminates its SSH client/channel. This is not a guarantee
that detached remote jobs or daemons have stopped. Likewise, cancelling a tool
command does not guarantee termination of all remote descendants. Durable
remote jobs need a separately managed remote task mechanism.

## Bounded Git status

Git status uses the selected directory as a literal pathspec, even when the
repository root is above it. Virtual remote subdirectories need not exist in the
local cache. Status/diff commands share a **30-second request budget**, and a
cancelled HTTP request aborts its active Git/SSH child without starting more work.
Stopping SSH still has the remote-descendant caveat described above.

Normal scans expand untracked directories (`--untracked-files=all`) and finish
without artificial batches. The fallback ceiling is **5,000 entries or 8 MiB**;
one look-ahead entry distinguishes an exact fit from an exceeded limit. When
exceeded, the output producer stops and no additional statistics pass starts.
The API retains optional `truncated`, `lineStatsTruncated`, and per-entry
`isDirectory` fields, and adds `lineStatsIncompleteReason` to distinguish actual
scan/read limits from the remote content-read policy. Only an unfinished file
listing receives a list warning and a `+` count. Git may inspect tracked files
before producing output; the command deadline also bounds that phase. Explicit
file diffs query only the requested literal path, not a full-repository status
first.

Remote polling **never downloads untracked file contents** just to count lines
(including files in `.ssh`). Only an explicitly requested diff reads their text.
Remote counts that only omit untracked files receive a neutral “tracked only”
note, not a scan-limit warning. Local untracked line counting runs asynchronously
so cancellation remains responsive. It follows the **5,000-file** listing ceiling,
with **32 MiB aggregate / 2 MiB per file** safeguards. Explicit text/diff previews
keep their existing 256 KiB per-file bound. These scan ceilings apply to both
local and SSH workspaces; they are emergency limits, not normal scan batch sizes.

## Current boundaries

Remote file browsing supports directories and UTF-8 text previews. `@` file
indexing and Git status/diff route remotely. Uploads, binary/media previews,
downloads, file watching, and remote worktree creation/removal/isolation are not
implemented; they must not write to or execute inside the compatibility cache.
Local workspace execution remains local; the Git scan limits above also apply.

## Verification

Automated checks use isolated metadata stores and mocked SSH/PTY operations;
they do not connect to a real host or modify SSH credentials/configuration.
Before release, explicitly authorize a real-host smoke check covering:

1. A local workspace plus two SSH workspaces; switching selection does not change
   an existing Agent or terminal target.
2. `pwd`, a UTF-8 path with spaces, input, resize, and Ctrl-C in the remote terminal.
3. Browser refresh/reconnect, terminal restart, expired IDs, SSH disconnect, and
   an invalid remote directory (no local fallback).
4. Remote read/search/edit, a default read-only subagent, and Git status/diff.
5. Existing local terminal and local Agent behavior.
