# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** via GitHub Security Advisories:
open the repository's **Security** tab and click **Report a vulnerability**. Do not open
a public issue for security reports.

We will acknowledge the report as soon as possible and coordinate a fix and disclosure
timeline with you.

## Scope notes

- fe-guard has **zero runtime dependencies**; the attack surface is the CLI / MCP server
  itself and the tools it orchestrates.
- ESLint / TypeScript / dependency-cruiser are installed by the target project, not by
  fe-guard; vulnerabilities in those tools should be reported to their respective projects.
- fe-guard runs local commands (git, the project's own lint/type tools) with the invoking
  user's permissions; it does not open network ports or transmit code anywhere.
