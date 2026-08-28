# Security Policy

Police Chief Bot is self-hosted — every alliance runs its own instance,
with its own bot token, its own database, and its own web dashboard (if
they've deployed one). A vulnerability here means a way to compromise
*any* self-hosted instance running the affected code, not a shared
service everyone depends on. Please still report it; a bug that lets one
instance's data leak or lets an unauthorized Discord user reach an admin
action is worth fixing regardless of how many people have deployed it.

## Supported Versions

This project moves fast and doesn't maintain older release branches —
only the latest release gets security fixes. If you're running an older
version, update first ([docs/installation.md](docs/installation.md#staying-updated)
or the web dashboard's own Update button) and confirm the issue still
reproduces before reporting.

## Reporting a Vulnerability

Please use GitHub's private vulnerability reporting rather than a public
issue: open the **Security** tab on this repository → **Report a
vulnerability**. That creates a draft security advisory only the
maintainer can see until it's resolved — nothing about the report is
public until then.

This is a one-person project, not a team with a formal SLA — there's no
guaranteed response time, but reports are taken seriously and get looked
at as soon as possible. Please don't open a public issue for anything
that could be actively exploited against someone's live deployment
before a fix ships.

## Scope

**In scope**: the Discord bot (`cogs/`, `main.py`), the web dashboard
(`webapp/`), and the Docker deployment configuration in `docker/` —
anything that could let someone bypass a permission check, access
another alliance's data, execute code they shouldn't be able to, or
otherwise compromise a deployment beyond what its own admins intended.

**Out of scope**:
- Vulnerabilities in third-party dependencies (Discord.py, Fastify, etc.)
  — please report those upstream, though a note here linking to the
  upstream report is still welcome.
- Issues that require an attacker to already have Bot Owner or Global
  Admin access on the target deployment — those roles are already
  fully trusted by design (see [docs/owner-guide.md](docs/owner-guide.md)).
- Social engineering, or physical/account access to someone's own
  Discord account, VPS, or machine.
