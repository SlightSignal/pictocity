@echo off
title pictocity
cd /d "%~dp0"

rem pictocity launcher -- written 2026-09-07 so the desktop shortcut has
rem something to point at. The project ships npm scripts and a Dockerfile
rem but no Windows launcher, and a shortcut straight to "npm run server"
rem would flash a black window and vanish.

rem A SYSTEM NODE WINS IF THERE IS ONE. The bundled copy in ..\node is a
rem portable unzip, not an install: it is on nobody's PATH, it touched no
rem registry key, and deleting that one folder undoes it completely. If a
rem real Node is ever installed properly, it should take precedence
rem rather than being shadowed by a private copy that nothing updates.
set "NODEDIR="
where node >nul 2>nul
if not errorlevel 1 goto have_node
if exist "%~dp0..\node\node.exe" (
  set "NODEDIR=%~dp0..\node"
  set "PATH=%~dp0..\node;%PATH%"
  goto have_node
)

echo.
echo   pictocity needs Node.js and none was found.
echo.
echo   Checked: PATH, and the portable copy at ..\node
echo.
echo   Either install the LTS from https://nodejs.org (tick "Add to
echo   PATH"), or restore the portable copy next to this folder.
echo.
pause
exit /b 1

:have_node
if defined NODEDIR echo [pictocity] using the portable Node in %NODEDIR%

rem First run does the one-time work. After that both checks are skipped
rem and this goes straight to the server.
if not exist "node_modules" (
  echo [pictocity] first run: installing dependencies, this takes a minute
  call npm install || (echo. & echo   npm install failed -- see the output above. & pause & exit /b 1)
)
if not exist "packages\server\dist\index.js" (
  echo [pictocity] building
  call npm run build || (echo. & echo   build failed -- see the output above. & pause & exit /b 1)
)

echo [pictocity] starting on http://localhost:4100   (data in .\data)
start "" "http://localhost:4100"
call npm run server

rem If the server exits the window would close instantly and take the
rem reason with it, so it is held open.
echo.
echo   pictocity server stopped.
pause
