# Dependency patch boundaries

## xterm 6.0.0: rendered cursor anchor

`@xterm__xterm@6.0.0.patch` changes four upstream source files. During
synchronized output, the parser cursor can move while the rendered grid remains
unchanged. The helper textarea and composition overlay must use the last rendered
cursor and its cell dimensions, not the intermediate parser position.

The patch records that snapshot after an actual render and updates the textarea
and composition overlay from the render service event, including redraw-only
renders. Coordinates are viewport-relative. It does not delay input, rewrite
PTY output, or add a composition timer.

The package's precompiled `lib` files are not patched. Vite development and
production use `scripts/build-xterm.mjs` to rebuild the patched source with the
existing esbuild dependency. Version and normalized source hashes are checked;
a missing or changed patch fails the build. Upgrades require explicit review.
Generated modules live in ignored `node_modules/.cache/hive-xterm`.

Use `pnpm install --frozen-lockfile` before building. npm consumers of the built
Hive package receive bundled Web assets, not a source build. Direct imports of
the dependency's stock `lib/xterm.mjs` remain stock; diagnostics must target the
rebuilt module or production Web chunk when claiming to validate this patch.

xterm is MIT licensed. Its package LICENSE is included as a legal comment in
the intermediate generated module. Because final bundling can remove comments,
Vite also emits the complete installed LICENSE as `licenses/xterm-LICENSE.txt`
in the Web output, included in the Hive archive. No fork is published and the
build requires no private machine path.

An isolated Chrome/WebGL check of the production chunk covers synchronized
output, composition start during output, composition end, subsequent English
and slash input, timeout release, resize, font changes and scrollback. It is not
native iPhone keyboard automation or a substitute for full engineering checks.

## Windows node-pty versus ConPTY

The previous pnpm-only node-pty patches have been removed to avoid maintaining
two implementations of the same cleanup fix. The Hive Windows launch path
now selects the reviewed JS in `vendor/node-pty-windows`, copied into `dist/vendor`
for npm users. Native code is still resolved from the installed platform package.
The Windows x64 scriptless package smoke passed natural exit without a post-exit
kill. Independent review of this candidate's JavaScript lifecycle and package
delivery changes is complete. ARM64 and Unix runtime verification remains
outstanding; review does not replace it or approve native binary distribution.
This is separate from the source-only native handoff.

The vendored node-pty JavaScript does not deliver the locally compiled
OpenConsole/ConPTY acceptance candidate. That candidate still needs reproducible
source/toolchain/artifact and packaging verification before claiming a checkout
alone reproduces all native runtime fixes. Local x64 acceptance is not ARM64
validation; an unsigned executable is not a signed upstream release; preview
source lineage must not be described as a stable release.

Do not distribute local loaders, pairing credentials, runtime SQLite files or
personal acceptance directories.

The selected native handoff is source-only:
[`conpty-da1-wait.patch`](conpty-da1-wait.patch) and
[`build instructions`](../docs/conpty-source-build.md). This standalone patch
targets Microsoft Terminal, not a pnpm dependency; it is not applied by install
and does not change Hive's default native backend.
The upstream copyright and MIT license for this source patch are retained in
[`conpty-LICENSE.txt`](conpty-LICENSE.txt); this is not a license inventory for
future compiled binaries or their linked dependencies.
