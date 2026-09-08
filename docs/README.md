# Documentation

**The handbook is published at
[addisdev.github.io/actions-runners](https://addisdev.github.io/actions-runners/)**,
which is the same Markdown as this directory with search, navigation and a
working link check over it. This index is here for anyone reading the
repository on GitHub instead.

Start with [Get started](getting-started.md) if you are new to the project, and
[Concepts](concepts.md) if something in the dashboard is not making sense.

## Guides

| Guide | When to read it |
|---|---|
| [Get started](getting-started.md) | First setup on a new host, to a job running on it |
| [Concepts](concepts.md) | Runners, drift, queue causes, admission, groups, alerts |
| [Workflows](workflows.md) | Configuring your GitHub Actions to use the fleet |
| [Dashboard](dashboard.md) | All views, queue diagnosis, actions, and alerts |
| [Operations](operations.md) | Day-to-day maintenance, drain/resume, health repair |
| [Admission and Scaling](admission-and-scaling.md) | Throttling concurrent jobs and autoscaling |
| [Ephemeral Runners](ephemeral-runners.md) | One-job disposable runners |
| [Federation](federation.md) | Coordinating runners across multiple Macs |
| [Security Hardening](security-hardening.md) | Deployment models and threat model |
| [Troubleshooting](troubleshooting.md) | Symptom → cause → fix |
| [Upgrading](upgrading.md) | Update and rollback procedures |
| [Uninstalling](uninstalling.md) | Clean removal from a host |

## Reference

| Reference | What it covers |
|---|---|
| [Architecture](architecture.md) | Component map, data flow, trust boundaries |
| [Configuration](configuration.md) | Every environment variable and live setting |
| [Scripts](reference/scripts.md) | Every script, its flags, and what it refuses to do |
| [API](api.md) | Dashboard HTTP endpoints |
| [Glossary](glossary.md) | Term definitions |

## Design notes

Why the daemon is shaped as it is. Each page is an argument, and each argument
is grounded in something that actually went wrong on a real fleet — see
[the overview](design/index.md).

| Note | The argument |
|---|---|
| [Zero dependencies](design/zero-dependencies.md) | Why a monitoring daemon has no npm packages |
| [Inferred groups](design/groups.md) | Why headings are derived from disk, never from the current tick |
| [The control plane](design/control-plane.md) | No shell, no free-form commands, and an allowlisted bundle |
| [Workflow lint](design/lint.md) | Parsing the YAML rather than grepping it, on the branches that run |
| [Alerts and autofix](design/alerts.md) | Transitions rather than levels, and what may act unattended |
| [Capacity and autoscaling](design/capacity.md) | Sizing per repo, and why the host tile shows pressure not swap |
| [Honest analytics](design/analytics.md) | What the numbers exclude, and why a job failed |
