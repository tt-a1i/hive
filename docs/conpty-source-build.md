# ConPTY source-only handoff

This candidate delivers a source patch and build instructions, **not native
binaries**. Normal Hive startup still uses the system backend. A normal install
must not be described as containing the native fix exercised in local acceptance.
Do not replace Windows system files, silently select a custom DLL, or copy a
private acceptance loader into the package.

## Exact source and patch

- Repository: `https://github.com/microsoft/terminal.git`
- Base: `9ae724aa5b080aafbeea2bbf88db630b182cc802` (`v1.25.622.0`, preview lineage).
- Upstream fix: commit
  `bfc054685cb3e1cd07fdf294a294f266934e3d1b`, titled
  `ConPTY: Do not wait for DA1 on startup (#20536)`. The commit and parent were
  fetched from the Microsoft repository and their VtIo.cpp diff verified.
- Patch: [`conpty-da1-wait.patch`](../patches/conpty-da1-wait.patch).

The patch gates the DA1 wait on the cursor-position handshake and reduces that
conditional wait to 1000 ms. It does not filter PTY output or fake a terminal
response. This is not a claim that every cursor problem has this cause; Hive's
rendered-cursor anchoring and input-owner changes remain separate.

Use an isolated checkout with no existing modifications. Substitute absolute
paths for `<source>`, `<hive-source>` and `<vcpkg>` below. Do not run these
commands against the active Hive instance or a Windows system directory.

```powershell
git clone https://github.com/microsoft/terminal.git <source>
git -C <source> checkout --detach 9ae724aa5b080aafbeea2bbf88db630b182cc802
git -C <source> apply --check --ignore-space-change <hive-source>/patches/conpty-da1-wait.patch
git -C <source> apply --ignore-space-change <hive-source>/patches/conpty-da1-wait.patch
git -C <source> diff --stat
```

Only `src/host/VtIo.cpp` should change. Its patched UTF-8 content, after converting
CRLF to LF, has SHA-256
`d5897f745a8b1a0cdeb8369c8877bc968f5884cc64e84fd59c390ddbfda40c45`.

## Toolchain and commands

The verified local x64 build used Visual Studio 2022 Build Tools, MSBuild
17.14.60.43110, MSVC 14.44.35207, Windows SDK 10.0.22621, and vcpkg commit
`15e5f3820f0370f1ba7150853762cec0688cd396`. Use the source's NuGet configuration
and package manifest. Install the C++ x64 build tools and stated Windows SDK
before building; tool installation is separate from this source patch.
Prepare a separate vcpkg checkout (or verify an existing checkout is at this
commit) rather than relying on an unspecified global vcpkg installation:

```powershell
git clone https://github.com/microsoft/vcpkg.git <vcpkg>
git -C <vcpkg> checkout --detach 15e5f3820f0370f1ba7150853762cec0688cd396
```

Start in `<source>` with the stated MSBuild version available on PATH:

```powershell
dep/nuget/nuget.exe restore dep/nuget/packages.config -ConfigFile NuGet.Config -NonInteractive
MSBuild src/host/exe/Host.EXE.vcxproj /m:4 /p:Configuration=Release /p:Platform=x64 /p:WindowsTerminalBranding=Preview /p:SolutionDir=<source>/ /p:VcpkgRoot=<vcpkg>/ /nologo
MSBuild src/winconpty/dll/winconptydll.vcxproj /m:4 /p:Configuration=Release /p:Platform=x64 /p:WindowsTerminalBranding=Preview /p:SolutionDir=<source>/ /p:VcpkgRoot=<vcpkg>/ /nologo
```

Paths containing spaces must be quoted. Check each exit code before proceeding.
Keep `OpenConsole.exe` and `conpty.dll` from the same build under
`bin/x64/Release`; do not mix a new executable with an unrelated packaged DLL.
Inspect hashes and Authenticode status before any separately approved trial.

## Verified evidence and limitations

A fresh source directory, with no prior obj/bin directories, built both targets
successfully with zero reported warnings/errors. It reused the installed
toolchain and download caches: this is not a clean-machine proof.

One resulting pair had SHA-256:

- OpenConsole.exe: `5d771e1020ea0d2870065dbc621c4ba740ee0d39cc146cc1c987c4adbbdf9aec`
- conpty.dll: `cd2def85481af6e3409047668ce858cec187922081970491b75fe4be82a7ae55`

Both were unsigned. A previous same-source build had different binary and code
section hashes. **Byte-for-byte reproducibility is not established.** These
hashes identify evidence artifacts, not an expected hash for every rebuild.

An isolated, hash-checked loader for this pair passed 18 tests in
`terminal-ws.test.ts`, `terminal-flow-control.test.ts` and
`agent-manager-pty-eof.test.ts`. A synchronized-output diagnostic also passed.
The loader is not distributed; running those tests with the default backend does
not validate a newly built pair. The rebuilt pair was not activated for iPhone
acceptance. User device feedback belongs to the separately recorded live
candidate, not every later binary. ARM64 and binary package delivery are unverified.

Root source `LICENSE` is MIT; `NOTICE.md` also lists third-party components.
Any future binary proposal must map the actual linked dependencies and retain
their applicable copyright/license notices, not infer blanket clearance from
the root license. This handoff does not authorize publishing binaries.
