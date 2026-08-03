@AGENTS.md

Everything in `AGENTS.md` applies. It is the single agent contract for this repo; this file exists only so Claude Code loads it.

If `@AGENTS.md` import is not resolving in your version, replace this file with a hardlink:

```powershell
# from repo root, PowerShell as admin not required for hardlinks on same volume
New-Item -ItemType HardLink -Path CLAUDE.md -Target AGENTS.md -Force
```
