@echo off
rem jukecord, run from the folder it was unpacked into (scripts/bundle.ts writes this file into each Windows program,
rem @YTDLP@ filled in and with Windows line endings):
rem
rem   .\jukecord start       run jukecord here, until Ctrl+C
rem   .\jukecord open        a login link, opened in the default browser
rem   .\jukecord <command>   anything else goes to the jukecord command: np, add, skip, link, status ...
rem
rem Node.js, FFmpeg and yt-dlp are the ones in lib\ beside this file. The settings are in .env beside it (copy
rem .env.example) or in the environment, which wins over the file. The data lives in %LOCALAPPDATA%\jukecord unless
rem JUKECORD_DATA_DIR says elsewhere, so a newer release unpacked beside this one finds it.
setlocal EnableExtensions
set "here=%~dp0"
set "here=%here:~0,-1%"
set "settings=%here%\.env"
if not defined LOCALAPPDATA set "LOCALAPPDATA=%USERPROFILE%\AppData\Local"
call :default JUKECORD_DATA_DIR "%LOCALAPPDATA%\jukecord"
call :default JUKECORD_FFMPEG "%here%\lib\ffmpeg\ffmpeg.exe"
call :default JUKECORD_YTDLP "%here%\lib\yt-dlp\@YTDLP@"
set "NODE_ENV=production"
set "node=%here%\lib\node\node.exe"
set "app=%here%\lib\app"
rem .env is named to Node only when it is there (Node says so about a file it was given that is not). The source is
rem already JavaScript, so Node's notice about stripping types would only be noise.
set "envfile="
if exist "%settings%" set envfile="--env-file=%settings%"
set "quiet=--disable-warning=ExperimentalWarning"

if /i "%~1"=="start" goto start
if /i "%~1"=="open" goto open
if "%~1"=="" goto help
if /i "%~1"=="help" goto help
if /i "%~1"=="-h" goto help
if /i "%~1"=="--help" goto help
"%node%" %envfile% %quiet% "%app%\src\cli\main.js" %*
exit /b %errorlevel%

:start
"%node%" %envfile% %quiet% "%app%\src\main.js"
exit /b %errorlevel%

:open
rem The link through a file of its own, read back whole: what the command prints is a single line.
set "linkfile=%TEMP%\jukecord-link-%RANDOM%%RANDOM%.txt"
"%node%" %envfile% %quiet% "%app%\src\cli\main.js" link >"%linkfile%"
set "code=%errorlevel%"
rem No link: the command has said why (jukecord not running, say), and its exit code stays.
if not "%code%"=="0" (
  del "%linkfile%" 2>nul
  exit /b %code%
)
set /p url=<"%linkfile%"
del "%linkfile%"
echo %url%
start "" "%url%"
exit /b 0

:help
echo   start                  run jukecord here, until Ctrl+C
echo   open                   a login link, opened in the default browser
echo.
"%node%" %envfile% %quiet% "%app%\src\cli\main.js" --help
exit /b %errorlevel%

rem A setting's value here when neither the environment nor .env gives one: Node reads the file and leaves alone what
rem the environment already has, so a default set here would hide the file's value.
:default
if defined %~1 exit /b 0
if exist "%settings%" findstr /r /b /c:"[ ]*%~1=[ ]*[^ #]" "%settings%" >nul 2>&1 && exit /b 0
set "%~1=%~2"
exit /b 0
