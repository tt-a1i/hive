# Windows node-pty JavaScript candidate

Source: installed `@lydell/node-pty-win32-x64` 1.2.0-beta.15, MIT license retained
in LICENSE. JavaScript files are platform-architecture-independent, but ARM64
runtime validation is still required; x64 results do not establish ARM64 support.

Local differences:

- `lib/windowsPtyAgent.js`: release input socket and output worker when output
  socket closes, after output drains. This is the single maintained cleanup fix;
  the earlier pnpm lifecycle patches have been removed.
- `lib/utils.js`: resolve native modules through the matching installed upstream
  platform package, rejecting version mismatch. No native binary is copied here.

All other JavaScript content is preserved from upstream, including its copyright
notices, with only an added final newline (not byte-identical files);
excluded from Hive formatting to keep the dependency diff reviewable. There are
no source maps in the upstream platform package; existing map comments are inert.

`src/server/pty.ts` selects this implementation only on Windows. Unix uses the
original dependency. `prepare-build-artifacts.mjs` copies these source files to
dist/vendor, making the reviewed JS available without postinstall scripts. Normal
native backend selection is unchanged; no custom ConPTY loader is activated.

The Windows x64 ordinary npm archive passed the natural-exit probe without a
post-exit kill and the HTTP/SQLite/internal-team smoke. Independent review of
this candidate's JavaScript lifecycle and package delivery changes is complete.
Other-platform runtime verification remains outstanding; this review is not
approval to distribute or activate custom native binaries. Dependency upgrades
require a new review of this vendored code and native compatibility, not merely
a version bump.
