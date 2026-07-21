@cd /d "%~dp0.." && git add -A && (git diff --cached --quiet || git commit -m "update") && git push yigerende master
