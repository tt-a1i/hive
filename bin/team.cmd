@echo off
if exist "%~dp0..\src\cli\team.js" (
  node "%~dp0..\src\cli\team.js" %*
) else (
  node "%~dp0..\node_modules\tsx\dist\cli.mjs" "%~dp0..\src\cli\team.ts" %*
)
