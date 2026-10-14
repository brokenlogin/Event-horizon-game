@echo off
rem Double-click (Windows) to host a REMOTE multiplayer game. Keep the window open while you play.
cd /d "%~dp0"
where py >nul 2>nul && (py -3 serve.py --remote --open) || (python serve.py --remote --open)
pause
