@echo off
rem =====================================================================
rem Memory Bank hook node launcher (rebuilt 2026-10-23).
rem
rem Resolution order:
rem   1. %~dp0node.exe -- a HARD LINK to the real node.exe of the shell
rem      that currently runs DSH. No path guessing, pure ASCII path.
rem      Rebuild after switching shells:
rem        cmd /c mklink /H "<this dir>\node.exe" "<shell>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
rem      NOTE: node.exe is NOT committed (see .gitignore) -- it is a machine-local
rem      hard link, so a fresh clone will fall through to the candidates below.
rem   2. %DSH_DESKTOP_NODE_EXECUTABLE% -- env var some shells export.
rem   3. %DSH_NODE_B% -- optional override for any other install location.
rem      (Was hard-coded to the author's own install path before 2026-11-08.)
rem   4. Whatever PATH resolves.
rem
rem 2026-10-23 incident: moving to DeepSeek Harness Desktop 0.2.1-rc.2
rem   installed under a CJK-named folder removed every candidate below, so
rem   this launcher fell through to `node` -> exit 9009 -> SessionStart
rem   injection silently disappeared (0 hook events in the session log).
rem   Same symptom class as the 2026-09-30 0xC0000142 case: a silent gap,
rem   not an error the UI shows.
rem
rem IMPORTANT: keep this file PURE ASCII. cmd.exe parses .cmd files in the
rem   OEM/ANSI code page, so UTF-8 CJK comments break command parsing.
rem =====================================================================
setlocal

if exist "%~dp0node.exe" (
  "%~dp0node.exe" %*
  exit /b %errorlevel%
)

if defined DSH_DESKTOP_NODE_EXECUTABLE (
  if exist "%DSH_DESKTOP_NODE_EXECUTABLE%" (
    "%DSH_DESKTOP_NODE_EXECUTABLE%" %*
    exit /b %errorlevel%
  )
)

set "NODE_A=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if exist "%NODE_A%" (
  "%NODE_A%" %*
  exit /b %errorlevel%
)

rem Optional override: set DSH_NODE_B to any node.exe you want to prefer.
if defined DSH_NODE_B (
  if exist "%DSH_NODE_B%" (
    "%DSH_NODE_B%" %*
    exit /b %errorlevel%
  )
)

set "NODE_C=%ProgramFiles%\nodejs\node.exe"
if exist "%NODE_C%" (
  "%NODE_C%" %*
  exit /b %errorlevel%
)

rem Fallback: whatever PATH resolves (may be a shim).
node %*
exit /b %errorlevel%
