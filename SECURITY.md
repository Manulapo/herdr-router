# Security

`herdr-router` runs agent CLIs on your machine and reads/writes your Claude Code `settings.json` only when you ask (`hroute install-hook --write`, `hroute setup --yes`), always with a backup.

- Secrets live in `~/.config/herdr-router/.env` (`chmod 600`); the tool warns if it is readable by others. It never reads a project-local `.env`.
- The handoff note and routing log stay in `~/.local/state/herdr-router/`. The handoff summary is produced by sending the tail of your Claude transcript to Haiku through your own subscription.
- Prompts are never sent to a third party except OpenRouter's Jev, and only when you set `OPENROUTER_API_KEY`.

To report a vulnerability, please open a private security advisory on GitHub (Security tab) rather than a public issue.
