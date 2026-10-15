# SQL Pulse

**Monitor. Diagnose. Tune.** Live multi-instance SQL Server performance monitoring and AI-assisted diagnostics powered by DMVs, Query Store, and a small Node.js HTTP server. Supports **on-prem SQL Server**, **Azure SQL Database**, and **Azure SQL Managed Instance**.

Created by **Luis Fernando Borbon** · MIT License

![Dashboard](https://img.shields.io/badge/status-live-brightgreen) ![Windows](https://img.shields.io/badge/platform-Windows-blue) ![Node.js](https://img.shields.io/badge/node-22.12%2B-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- 🔴🟡🟢 **Traffic-light health indicator** — instant summary of overall server state
- 📊 **Rich metrics**: Page Life Expectancy, Buffer Cache Hit Ratio, Top Waits, Top Queries (Query Store), Missing Indexes, File I/O Latency, Buffer Pool distribution, TempDB usage, Active Sessions
- 🖱️ **Interactive query detail** — click any Top Query to see full text, execution plan XML, `sp_query_store_force_plan` DDL
- 🛠️ **CREATE INDEX generator** — click any Missing Index to get ready-to-run T-SQL
- 🌐 **Fleet overview and drill-down** — compact all-server health and resource cards, filtering, freshness/error indicators, and a detailed dashboard for each connection
- 🎨 **11 themes** — Clawpilot, Ocean, Emerald, Cyberpunk, Solarized (both light/dark), Nord, High Contrast
- 🔒 **Encrypted credentials** — AES-256-GCM at rest, key wrapped with Windows DPAPI (user-scoped)
- 🔐 **Authentication options** — Windows Integrated, SQL Auth, verified Entra Azure CLI session, Entra ID Password, Entra ID Interactive (MFA)
- ⏸️ **Pause + configurable refresh** — persistent per-server monitoring pause; separate browser-view pause and 30s to 30min refresh
- 🌍 **Friendly URL** — `http://sql-dashboard:8765/` via hosts alias
- 🚀 **Auto-start at logon** — no manual restart after reboot
- **AI settings and visual assistance** — Configure AI provider in Settings; Ask AI on each chart, KPI and custom-counter card sends only the selected visual's reviewed context
- **Review before sending** — preview the complete question, system prompt, SQL context, and destination; only the approved payload is sent
- **Reliable persistence and refresh** — atomic, serialized configuration updates; shared in-flight collection across tabs; independent refreshes when switching servers
- **Trend history and custom counters** — up to 720 persisted samples per server, sparklines, thresholds, and browser-local alert transitions
- **Professional desktop launcher** — original nine-size high-DPI icon, concise SQL Pulse shortcut, no terminal flash, and startup readiness checks
- **Responsible-use notice** — shown before first use in each browser and available again under About and disclaimer
- **Compact connection editor** — wider two-column desktop layout, wrapped diagnostics, manual database entry, and explicit SQL Server / Azure SQL Database / Managed Instance selection
- **Email notifications** — encrypted SMTP configuration, recipients, warning/critical/recovery triggers, persistent deduplication and explicit template approval; disabled by default
- **Lightweight counters** — engine-specific templates, independent sampling intervals, pause/enable, strict numeric tests, threshold validation, and bounded query execution
- **Service identification** — SQL Server, Azure SQL Database, and Azure SQL Managed Instance badges in overview, sidebar, and details

## Quick install (Windows)

Download the installer ZIP from [Releases](https://github.com/LuchoBorbon76/SQLDashboard/releases), **extract it**, and run `install.bat`. The package includes setup instructions, user documentation, and the MIT license. Do not run the installer from inside the ZIP preview. Internet access and Windows package-install permissions are needed to install prerequisites and locked npm dependencies.

To run from source after installing the prerequisites:

```powershell
# Clone
git clone https://github.com/LuchoBorbon76/SQLDashboard.git
cd SQLDashboard

# Install dependencies
npm ci

# Run
node server.mjs
# Open http://127.0.0.1:8765/
```

## Full installer (recommended)

The `installer/` folder ships a Windows installer that:

- Checks and repairs required tools through **winget**; no ODBC driver is needed by the collector
- Adds `sql-dashboard` to your hosts file (friendly URL)
- Registers a Task Scheduler job for auto-start at logon
- Creates Start Menu + Desktop shortcuts

```powershell
cd installer
.\install.bat
```

See [installer/README.md](installer/README.md) for options.

## Architecture

```
Browser (index.html)
        │
        ▼  HTTP polling every 30s (configurable)
Node.js HTTP server (server.mjs) :8765
        │
        ▼  Spawns per-request
go-sqlcmd 1.10+ (all authentication methods)
        │
        ▼  Windows Auth / SQL Auth / Entra ID
Target SQL Server / Azure SQL DB / Azure SQL MI
```

- **Node HTTP** serves static HTML and a `/api/metrics?serverId=X` endpoint
- **Metrics collector** uses one frequent DMV batch plus independently cached inventory/Query Store batches; expensive scans are not repeated for every refresh
- **Per-server snapshot cache** (30s) shares samples across browser tabs, overview, details and AI previews, with a 15s minimum forced/retry window
- **In-flight deduplication** shares concurrent requests, including AI previews; unique temporary SQL files avoid cross-request collisions
- **Client-side per-server cache** shows the last snapshot instantly when switching servers
- **Provider adapters** keep AI answer-only: no SQL execution, filesystem access, or MCP tools are exposed to the model

## Requirements

- Windows 10/11 (Task Scheduler + PowerShell 5.1+)
- Node.js 22.12 or newer (20.19.x is also supported)
- [go-sqlcmd](https://github.com/microsoft/go-sqlcmd) 1.10+ (used for all SQL connections; no ODBC driver required by the collector)

The full installer repairs Node.js/npm, Go sqlcmd, GitHub CLI (`gh`) and Azure CLI (`az`) through winget by default; `-Minimal` omits the two optional authentication CLIs. GitHub Copilot still needs a Copilot-enabled account, and Azure Entra authentication needs a user-authorized Azure CLI session. Missing App Installer/winget, denied elevation or offline/policy restrictions are reported with setup guidance rather than bypassed.

SQL permissions and network access are separate prerequisites: use an authorized read-only SQL login with the DMV/Query Store permissions required by its service and SQL version. Private Managed Instance endpoints require an appropriate VPN/VNet route; public endpoints require their configured TCP port. The installer does not change SQL permissions, firewall rules, Microsoft tenant policy, app registrations, or mailbox settings.

## Release 1.4.2

This release includes the SQL Pulse branding and Windows shortcuts, compact fleet/detail dashboards, per-server pause tags and sampled trends, lighter bounded collection, redesigned counters, contextual answer-only AI chat with stable snapshots and consent, GitHub/Microsoft SQL sign-in improvements, and optional approved SMTP notifications. Microsoft email uses OAuth2 with your own app registration; Gmail password mode needs a Google app password. The email master switch now greys and disables all dependent controls when off, while delivery tests preserve the typed password masked for retry and saving. Existing configuration paths and saved encrypted credentials remain compatible.

## Troubleshooting

| Symptom | What to check |
|---|---|
| Installer cannot download prerequisites | Verify internet access, winget/App Installer and package-install permissions; follow its diagnostic instead of bypassing errors. |
| SQL connection fails | Confirm target type, hostname/port, tenant/account, network route and SQL permissions; read the displayed redacted diagnostic. |
| Entra sign-in is required | Use the connection's explicit Test/Load sign-in; background collection never opens a login browser. |
| Gmail rejects the password | Use a Google app password with 2-Step Verification, not the normal account password. |
| Outlook.com rejects a correct password | Select Microsoft OAuth2 and configure the registered client ID; password SMTP cannot bypass Modern Auth. |
| Email options are grey | Check Enable email to edit; review and approve settings before background notification starts. |
| UI still looks like an earlier release | Press Ctrl+F5; the running app serves the newly installed files. |
| Dashboard does not start | Review `%LOCALAPPDATA%\SqlDashboard\server.err.log`; ensure port 8765 belongs to SQL Pulse and supported Node is installed. |

Email remains disabled by default. Authentication success is not a delivery guarantee, and a diagnostic/test must not be retried blindly after an uncertain accepted outcome.

## AI providers

Open **Settings → Configure AI provider** to select a provider and save its settings. Each provider retains its own endpoint, model, reasoning options, and encrypted credential when switching providers. Leaving a credential blank preserves it; use **Clear saved credential** to remove it. Provider configuration is available even before adding a SQL server.

| Provider | Configuration |
|---|---|
| GitHub Copilot | Sign in with GitHub CLI or save a Copilot-enabled token; choose a model available to your plan |
| OpenRouter | API key and a discovered or explicitly entered model ID |
| Azure AI Foundry / Azure OpenAI | OpenAI-compatible v1 endpoint and actual deployment name; existing Azure CLI Entra session or API key |
| OpenAI | API key and model; optional compatible base URL |
| Anthropic Claude | API key and Claude model; native Messages API |
| Local model | OpenAI-compatible base URL (LM Studio, vLLM, or Ollama `/v1`) and model; optional API key |
| Ollama (native) | Original default; `/api/tags` discovery and `/api/chat`, preserving `OLLAMA_URL` |

Azure resource roots such as `https://RESOURCE.openai.azure.com` are normalized to `/openai/v1`. Foundry endpoints must expose the OpenAI-compatible v1 API; this does not add support for every Foundry inference protocol. Azure deployments are entered explicitly because model catalogs do not enumerate deployment names. Reasoning controls are enabled only where supported; Azure/local deployments require an explicit declaration of support.

**Test provider** sends only the displayed generic health-check prompt, not SQL data. To ask about SQL, drill into a server and click **Ask AI** on a chart, KPI, or counter. One question box and **Send question** button handle the conversation. Recommended questions are tailored to the selected visual or KPI (for example, head blockers, signal versus resource waits, Query Store CPU consumers, or counter threshold meaning). Short suggestion labels populate the complete question without sending anything; hover tooltips and accessible labels contain the full question. Provider settings and **Context & privacy** stay collapsed unless opened. The viewport-sized chat window keeps the composer visible without an outer scrollbar; only long conversations and expanded details scroll internally. Opening analysis captures a bounded, read-only snapshot from the existing collector cache without running SQL, sending a prompt, or initializing model discovery. If the viewed snapshot has already aged out, Context explicitly identifies the newer cached snapshot instead of silently substituting it.

The captured context stays pinned for follow-up questions even while the dashboard refreshes. **Send question** automatically prepares the exact payload and opens a compact confirmation showing the question, destination and snapshot. **Show exact data sent** expands the full question, prior conversation and context. Nothing goes to the provider until you confirm; cancellation preserves your question. Only successful prior turns are included; history is bounded to six recent turns and 32,000 characters, with long answers explicitly marked truncated. **Refresh context** starts a new conversation from the latest cached sample without triggering collection. Context expires after 30 minutes; individual reviews expire after five minutes and cannot be replayed. Changes to server/provider configuration still invalidate consent, but ordinary sample updates do not. Query text, database names, metrics and chat can be sensitive; use approved providers and follow your organization's disclosure policies. Cloud and network providers send data off the machine.

An empty chat opens at content height instead of reserving a blank conversation area. The window expands when messages arrive, stays within the viewport, and returns to compact size when context is refreshed. Sidebar settings use shorter single-line rows and a compact footer so more saved servers remain visible.

Primary and secondary action buttons use a shared compact style across the sidebar, dashboard and dialogs, with consistent spacing, rounded corners and visible keyboard-focus outlines. Large navigation cards and provider selectors retain their content-driven layout.

## Fleet overview and collection cost

The landing page shows every saved connection with compact resource/health cards and small trend lines beneath CPU, memory, sessions, active and blocked numbers. Compact overview and detailed-server headers, inline health totals and smaller filters leave more room for metrics; Counters and Save baseline appear only in detailed dashboards. The sidebar groups AI and email configuration under Settings, shows email monitoring status, and labels its Theme, About and Exit actions. Trends reuse up to 30 already-collected samples without extra SQL; unknown values and long gaps are not connected. They build up as samples arrive and reset when SQL Pulse restarts. Click a card or sidebar connection to open all details; **All servers** returns to the overview. Search and service/group filters do not change server configuration. Missing or unavailable measurements are shown as unknown, not zero or healthy.

Collection uses at most **two SQL subprocesses at a time** across all views, instances, and counter tests. Per-instance single-flight requests prevent overlapping snapshots after credential changes. Browser polling pauses when hidden; without opted-in email monitoring, overview collection uses a finite viewing lease and stops when nobody is viewing it.

In a server's detailed dashboard, **Pause server** persists the selected server's monitoring state and displays a **Paused** tag in its card, sidebar and detail heading. New SQL collection and email observation stop only for that server; work already running may finish. **Read cached sample** does not run SQL, and **Resume server** resumes only that connection. In-memory samples are retained until app restart; a paused server with no cached sample shows that explicitly. **Pause view** on All servers only stops this browser's automatic refresh and leaves saved server pause states and approved background email monitoring unchanged.

| Data | Normal cadence |
|---|---|
| Core health, resources, waits, sessions, blocking and file I/O | Shared 30-second snapshot; background email cadence defaults to 60 seconds |
| Database inventory, buffer-pool descriptor scan and missing indexes | 5 minutes per connection |
| Query Store top queries | 2 minutes, weighted statistics over intervals covering the recent hour |
| Custom counters | Independent 2-minute default, configurable from 1 minute to 1 hour |

Manual refresh and additional tabs reuse fresh samples rather than forcing full SQL scans. Expensive data shows its independent sample timestamp. Ancillary failures preserve the previous result with explicit stale/error metadata; stale data is not scored as fresh. Cumulative waits are labelled historical signals, not proof of a current bottleneck. Managed Instance's platform-managed backups are not incorrectly flagged as missing local backups.

## Custom counters

Open **Counters** in a server's detailed view. Load an engine-compatible template or write one read-only `SELECT`/`WITH…SELECT` returning exactly one finite numeric row and column. Add upper/lower warning and critical thresholds, choose a sampling interval, and pause a counter without deleting it. Saving does not execute SQL; **Test SQL now** explicitly runs it once. Cards show sample age, cached/stale/error status, and contextual AI assistance.

Each connection supports at most 20 counters, with two concurrent counter queries within the shared global SQL limit and a 12-second execution budget. Disabled counters make no SQL calls; failed attempts retain a cooldown until the next counter interval. Only one SELECT is accepted; writes, SQLCMD directives, external sources and unsafe locking instructions are blocked. This query filter is not a SQL sandbox: use a read-only account and avoid expensive table scans. Existing counters migrate to enabled with a 120-second interval.

## Email alerts

The detailed **Alerts** dialog separates **Active** issues from browser-stored **History**. **Clear history** deletes only recorded transitions for the selected server, switches to the empty History tab, and confirms completion. Active warnings remain until their SQL condition is resolved; clearing history does not dismiss them or reset email deduplication.

Open **Settings → Email alerts** or configure email from Alerts. Add recipient addresses, a sender and an authorized SMTP relay/account. SMTP requires implicit TLS or verified STARTTLS; stored usernames/passwords are encrypted with the same DPAPI-protected key as SQL credentials. Credentials are never returned in settings or stored in the browser.

### Outlook / Microsoft email sign-in

Outlook.com requires Modern Auth (OAuth2); a correct Microsoft password is not sufficient for password-based SMTP. Select **Microsoft sign-in (OAuth2)**, then use your own app registration:

1. Register an application in Microsoft Entra that supports **personal Microsoft accounts** for Outlook.com, or your organizational accounts for Microsoft 365.
2. Under **Authentication → Mobile and desktop applications**, add `http://localhost/callback`. Do not create or enter a client secret.
3. Add the **Office 365 Exchange Online → Delegated → SMTP.Send** permission. SQL Pulse also requests `offline_access` for silent renewal.
4. Enter the **Application (client) ID** in Email alerts. Use `consumers` for personal Outlook, `common` for personal/work accounts, or your tenant ID/domain.
5. Use `smtp-mail.outlook.com` (Outlook.com) or `smtp.office365.com` (Microsoft 365), **port 587**, **required STARTTLS**. Choose **Sign in with Microsoft**, complete browser consent, then separately preview and approve your email settings or delivery test.

SQL Pulse uses a PKCE-protected authorization-code flow with a short-lived loopback callback, the official MSAL library, an encrypted local token cache, and silent token renewal. It never uses your Microsoft account password or launches sign-in during monitoring. Account/app changes invalidate reviewed settings; expired consent requires explicit sign-in again. Tokens are sent only to the two supported Microsoft SMTP endpoints. Work accounts may require admin consent and SMTP AUTH enabled for the mailbox; signing in cannot bypass tenant policy.

See [Microsoft SMTP OAuth documentation](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth) and [Outlook.com settings](https://support.microsoft.com/en-us/outlook/pop-imap-and-smtp-settings-for-outlook-com). SMTP password / authorized relay mode remains available for other providers.

**Show password** reveals only text entered in the current SMTP password field. It resets to hidden when the dialog closes or settings are saved. Leaving the credential fields blank preserves stored credentials; the dialog does not offer credential-removal checkboxes.

For **Gmail**, use `smtp.gmail.com`, port **587**, required **STARTTLS**, your full Gmail address, and a [Google app password](https://myaccount.google.com/apppasswords) created after enabling 2-Step Verification. Your normal Google account password is not supported for this SMTP flow. App passwords may be unavailable under account/security policies; SQL Pulse does not bypass these restrictions. Delivery tests keep your typed credential masked in the open dialog during execution and after either result, so you can retry or save without retyping it. Closing or saving clears it from the browser field; tests do not save credentials automatically.

Email is **disabled by default**. Enabling requires a preview showing recipients, triggers, polling interval, cooldown and exact message templates, followed by explicit approval. A delivery test has its own exact-message preview and approval; previewing never sends mail. Default messages exclude SQL text, database names, server addresses, custom-counter names and metric values. Including a connection display name is a separate private-data option included in the approval warning. SMTP acceptance does not guarantee inbox delivery.

When **Enable email + background monitoring** is unchecked, all other settings and actions are disabled and greyed out. Checking it unlocks the form but does not start background sending until you review and approve settings. Unchecking it stops previously approved background email monitoring immediately without discarding your form draft; an SMTP operation already accepted may finish. The main switch and Close remain usable when idle.

Notifications detect new warning/critical conditions, connection outages and confirmed recovery on the next completed poll—not instant SQL push. Default background polling is 60 seconds (minimum 30), with persistent transition deduplication and a notification cooldown. Fresh cached counter samples retain their severity; missing/stale samples never falsely confirm recovery. Delivery failures are visible; only definite pre-acceptance failures receive bounded retries, and uncertain/partially accepted sends are not blindly repeated.

Email monitoring continues without an open browser only after approved enabling, while this computer is awake and SQL Pulse remains running. **Disable immediately** stops future notification work; a message already handed to SMTP may finish. The app does not configure a mail server, bypass SMTP authentication, or use your Microsoft 365 mailbox automatically.

GitHub device sign-in displays a selectable, read-only code, a **Copy code** button, and the verification link in the dialog. Paste the copied code into GitHub with Ctrl+V; if clipboard access is blocked, select the code and use Ctrl+C. Background sign-in polling preserves code selection and copy feedback. Sign-in remains available while models load in the background; it does not depend on saving model settings. **Switch GitHub account** displays a foreground confirmation because it changes the shared GitHub CLI identity. It does not automatically log out other cached accounts. An existing credential is not treated as completion of a new device flow, and a pending flow is restored when reopening or reloading the page.

Environment credentials are supported through `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `OPENROUTER_API_KEY`, `AZURE_OPENAI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `LOCAL_AI_API_KEY`, and `OLLAMA_API_KEY`. Saved credentials take precedence. Secrets are never returned in settings responses or stored in browser storage.

## Configuration and reliability

First-time installations start with an empty server registry; add your own connection. Corrupt configuration, inaccessible files, and failed password migration are reported rather than replaced with default connections. Configuration mutations use serialized read-modify-write and atomic replacement, preserving concurrent edits.

The connection editor recognizes Managed Instance public endpoints such as `instance.public.zone.database.windows.net,3342` and VNet endpoints such as `instance.zone.database.windows.net`. A database is optional for Managed Instance and SQL Server; a blank value uses the login's default database. Azure SQL Database requires a database name, which you can enter directly without using **Load**. For aliases or nonstandard endpoints, choose the SQL target explicitly. Engine-edition probing remains authoritative after connection.

Entra connections expose an optional **Tenant ID or domain** for cross-tenant access. Use the account authorized for the SQL instance and its resource tenant. Neither Azure subscription access nor successful AI-provider sign-in grants SQL database permissions. Managed Instance public endpoints also require TCP connectivity on port 3342; private/VNet endpoints require the corresponding network route. The app does not modify endpoint, firewall, or SQL permissions.

**Microsoft browser sign-in (recommended)** uses normal authorization-code sign-in: the tab opened from Test/Load goes directly to Microsoft's account page, with no device code to enter. The app hands the actual Azure CLI authorization URL to this foreground tab instead of opening a hidden Windows account picker or a second browser window. A visible **Open Microsoft sign-in** link is available if popups are blocked. The broker and terminal subscription selector are disabled only in the child-process environment, never in global Azure settings.

**Microsoft device code (alternative)** remains available in Authentication. Its code appears inside SQL Pulse with a **Copy code** button for pasting into the Microsoft page; manual selection/Ctrl+C remains available if clipboard access is blocked. Browser sign-in is the default for existing connections unless device-code flow was explicitly saved. The internal SQL auth value remains `azuread-interactive`, with per-connection `entraFlow` selecting `browser` or `device-code`.

Both flows verify the SQL token's user and tenant before connecting. An existing account for another user is not silently reused. An optional tenant scopes sign-in. Background monitoring never opens a sign-in browser; expired or mismatched credentials require reconnecting through Test or Load. **Entra ID - existing Azure CLI session** uses only a verified cached CLI identity and never opens a browser. It is not Windows SSPI; use **Windows Integrated** for SSPI. The legacy internal authentication value `azuread-integrated` is retained for upgrade compatibility.

The app cannot repair a Microsoft passkey failure or override tenant policy. On Microsoft's page, use **Sign in another way** if offered; password, Authenticator, security key, or other available methods remain governed by your tenant's MFA/Conditional Access rules. SQL Pulse never bypasses MFA or falls back silently to password authentication.

The connection dialog displays live progress (authentication queue, account verification, device sign-in, SQL test, and save) with elapsed time. **Stop test** cancels pending authentication/SQL and restores the editable fields only after cancellation is confirmed. The overall operation is bounded; cancellation before saving never stores a connection. Once a verified save is committing, cancellation is disabled to avoid falsely reporting an unsaved result. If the response times out during saving, refresh and check the server list before retrying to avoid duplicates. The app does not change Windows broker settings; it disables the CLI's terminal-only subscription selector only in its child-process environment.

Device prompts support both Microsoft's current `https://login.microsoft.com/device` address and the older `https://microsoft.com/devicelogin` address, including formatted or line-wrapped CLI output. Browser URLs must be Microsoft authorization-code requests using the CLI's local callback. A verified URL/code must arrive before the app navigates the sign-in tab. If Azure CLI does not produce a usable prompt within one minute, the test stops with a diagnostic instead of leaving an empty sign-in tab indefinitely.

SQLcmd is called with Go-compatible encryption flags, fail-on-error handling, stderr diagnostics, and environment-provided passwords rather than plaintext command-line passwords. Full SQL/connection diagnostics are preserved and secrets are redacted before display.

References: [Managed Instance endpoint architecture](https://learn.microsoft.com/en-us/azure/azure-sql/managed-instance/connectivity-architecture-overview?view=azuresql) and [Microsoft Entra authentication in sqlcmd](https://learn.microsoft.com/en-us/sql/tools/sqlcmd/sqlcmd-authentication?view=sql-server-ver17).
Device-code flow: [Sign in interactively with Azure CLI](https://learn.microsoft.com/en-us/cli/azure/authenticate-azure-cli-interactively?view=azure-cli-latest).

The desktop editor keeps Test & Save visible at common desktop sizes; narrow or short screens retain vertical scrolling for accessibility. Long errors wrap and can be expanded under **Show full diagnostic**.

Runtime files default to the application directory. Set `SQL_DASHBOARD_DATA_DIR` to a separate directory to isolate configurations, keys, scratch files, and history; set `SQL_DASHBOARD_PORT` to change the default `8765` port. The supplied launcher and shortcuts use the default port. The HTTP server remains loopback-only and accepts the `127.0.0.1`, `localhost`, and `sql-dashboard` hostnames.

The SQL Pulse name does not rename existing configuration folders, the `SqlDashboard-Autostart` task, environment variables, or the GitHub repository. This preserves upgrade compatibility. Installation replaces old shortcuts belonging to this install with **SQL Pulse**, without removing unrelated shortcuts.

Do not run multiple dashboard processes against the same data directory. Serialization protects concurrent requests within one process, not independent processes. Back up `servers.json`, `ai-settings.json`, `alert-settings.json`, `alert-state.json`, `microsoft-email-auth.json`, and `.encryption-key` together. Windows DPAPI binds encrypted credentials to the Windows user and machine.

## Security

Saved passwords, AI API keys, GitHub tokens, and the Microsoft email token cache are encrypted at rest:

1. Server AES key (32 bytes) is generated on first save and wrapped via `System.Security.Cryptography.ProtectedData.Protect(..., 'CurrentUser')` (Windows DPAPI)
2. Wrapped key sits in `.encryption-key`; can't be decrypted by another Windows user or off-machine
3. Each password is AES-256-GCM encrypted with a unique 12-byte IV; format: `enc:v1:<iv>:<tag>:<ciphertext>` (all base64)
4. API responses never include encrypted or decrypted credentials — only presence flags
5. Server/provider settings are git-ignored. A missing or corrupt existing encryption key is not silently replaced during decryption.

## Development

Run `npm test` for native Node tests covering configuration preservation, concurrent collections, server switching, provider routing, and preview approval. Tests use synthetic data and mocked AI/SQL execution.

To create a distributable installer, synchronize `installer/payload` with the application files, then run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Build-Installer.ps1`. It writes a versioned installer ZIP and SHA256 checksum into `dist`, validates source/payload parity, and packages only whitelisted application assets, installer scripts, existing documentation and the MIT license. Runtime credentials, token caches, server registries, history, dependencies and Git metadata are never included. The ZIP requires extraction before running `install.bat`; internet access is needed for prerequisite and locked dependency downloads.

## Roadmap

- [x] Trend charts (last N samples per KPI)
- [x] Approved email alerts for warning/critical/recovery conditions
- [ ] Alert webhook (Teams, Slack) when health goes Critical
- [ ] Historical persistence (SQLite)
- [ ] Windows Service wrapper (nssm) for shared installs

## Contributing

Issues and PRs welcome. This is a personal project maintained in spare time — no SLA.

## Disclaimer

This is independent software created by Luis Fernando Borbon, not an official Microsoft or GitHub product and not affiliated with or endorsed by either company. Provided **as-is**, without warranty or support commitment, under the MIT License. Use at your own risk.

Use only authorized connections and least-privilege accounts. Metric collection is read-only, but polling and custom counters add workload. The manual **Kill Session** action changes server state and can interrupt work or trigger rollback; it requires SQL permissions and confirmation. Generated index and plan scripts are suggestions to review and test, not automatic changes.

AI output may be incomplete or incorrect and requires qualified review. Cloud/network AI providers receive the approved question and SQL context, which can contain sensitive query text, database names, and measurements. Review the exact payload and destination each time and follow your organization's disclosure policies. Provider retention, licensing, quotas, and charges apply. A local endpoint does not guarantee that the hosted model never makes network calls. AI cannot execute SQL or system tools in this app.

Saved credentials are encrypted; registry metadata, history, and browser snapshots are not encrypted by this app. Protect the Windows account, data folder, and backups. Metrics may be delayed, cumulative, or limited by permissions; health indicators are heuristics, not availability, backup, or recovery guarantees.

The full notice is shown before monitoring starts on first use in each browser. **I understand - open dashboard** records only a versioned browser acknowledgement, not approval to execute SQL actions or send AI data. The About and disclaimer button always reopens the notice.

## License

MIT © 2026 Luis Fernando Borbon — see [LICENSE](LICENSE).
