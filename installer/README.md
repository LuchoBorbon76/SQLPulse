# SQL Pulse — Installer

A live, multi-instance SQL Server performance dashboard powered by DMVs and Query Store, with support for on-prem SQL Server, Azure SQL Database, and Azure SQL Managed Instance.

**User prerequisite for live monitoring:** at least one Azure SQL Database or Managed Instance must be **registered in SQL Pulse**. The global prerequisite applies only when no Azure SQL connection is registered; SQL Server-only registrations do not satisfy it. Until registration, a persistent banner disables refresh/countdown and live collection/actions for every connection. Adding/testing SQL Server and Azure connections, stored history/reports and local AI settings remain available. This is not licensing or automatic cloud provisioning.

The backend reads only the saved registry at startup, after registration changes and periodically for external edits. It does not run prerequisite SQL probes, read tokens, open sign-in or expire successful connections. Paused/unreachable services, authentication failures, expired tokens and offline Azure services never globally lock monitoring; ordinary connection failures remain per-server. Removing or reclassifying the last Azure registration restores the prerequisite; adding one unlocks it immediately. Paused connections and saved monitoring preferences remain unchanged. An unreadable/corrupt registry reports registration status unavailable and fails closed. No new permissions or cloud resources are created.

## What's in this package

| File | Purpose |
|---|---|
| `install.bat` | Double-click to install; prerequisite packages may request administrator approval |
| `install.ps1` | The actual PowerShell installer |
| `uninstall.bat` / `uninstall.ps1` | Removal |
| `payload/` | Application source (Node.js server + HTML dashboard) |

## Quick install

**One-click:**
1. **Extract the entire release ZIP** to a local folder; do not run from inside the ZIP
2. For upgrades, finish/cancel SQL tests, sign-ins and queries, then stop the existing SQL Pulse process (closing the browser does not stop it)
3. Double-click **`install.bat`**; it checks and repairs the prerequisites listed below
4. Approve Windows package installation if requested; denied permissions, network restrictions or installation failures are reported, not silently ignored
5. After **INSTALL COMPLETE**, open **Start Menu → SQL Pulse → SQL Pulse** or the Desktop shortcut

The **SQL Pulse** shortcut uses a nine-size high-DPI icon and a hidden Windows Script Host launcher. It checks that the server is ready before opening the browser, reuses the installed dashboard process, and reports startup problems without stopping unrelated applications. Autostart runs silently without opening a browser. Existing settings remain in `%LOCALAPPDATA%\SqlDashboard` for upgrade compatibility.

The installer itself does **not** launch SQL Pulse, open a sign-in browser, log in to any service, grant consent, or create cloud resources. A successful installation registers logon startup unless disabled; open the shortcut when ready.

**Advanced (PowerShell):**
```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 [options]
```

### Options

| Flag | Description |
|---|---|
| `-InstallDir <path>` | Override target folder (default: `%LOCALAPPDATA%\SqlDashboard`) |
| `-Minimal` | Install/check Node + Go sqlcmd only; omit GitHub CLI/Azure CLI feature checks |
| `-UserScopeOnly` | Never retry prerequisite packages at default/machine scope; fail if no usable per-user installation is available |
| `-SkipPrereqs` | Skip CLI checks and repairs (expert/offline use); working supported Node + npm are still required for locked dependency installation |
| `-NoShortcuts` | Skip Start Menu / Desktop shortcut creation |
| `-NoAutostart` | Skip auto-registration of the "start at logon" scheduled task (autostart is enabled by default) |
| `-NoHostsEntry` | Skip the separate hosts-file elevation request; use `http://127.0.0.1:8765/` |

## Prerequisites (checked and repaired automatically)

| Component | Purpose | winget ID |
|---|---|---|
| **Node.js + npm** | Runs the dashboard, Copilot SDK and MSAL; supported range is `^20.19.0 \|\| >=22.12.0`; missing/unsupported versions are repaired with current LTS | `OpenJS.NodeJS.LTS` |
| **go-sqlcmd 1.10+** | SQL connections for all authentication methods; ODBC is not required | `Microsoft.Sqlcmd` |
| **GitHub CLI (`gh`)** | GitHub Copilot browser login; checked by default, omitted with `-Minimal` | `GitHub.cli` |
| **Azure CLI (`az`)** | Entra SQL authentication using app-owned browser/device sessions or the explicit shared-session mode; checked by default, omitted with `-Minimal` | `Microsoft.AzureCLI` |

Requires Windows PowerShell **5.1+** on Windows 10/11 with Windows Package Manager available. If every required tool is already usable, no package installation is attempted. Executable version probes reject old Node and old/ODBC sqlcmd. Selected absolute paths are saved in `.sql-pulse-tools.json`; the launcher and runtime revalidate them instead of trusting filenames or an older machine-first PATH. Standard, custom PATH, and WinGet locations are searched if a saved executable moves. The installer uses the selected Node's `npm.cmd` immediately, without reopening the terminal or requiring an npm PowerShell execution-policy exception.

Repairs use exact package IDs from the `winget` source, first at user scope, then at package-default scope if necessary. Some packages only support machine scope and may trigger Windows UAC; use `-UserScopeOnly` to prevent that fallback. The application itself stays per-user. Offline/managed systems may require IT-approved installation; if a selected tool still fails its version probe after repair, installation stops with the package ID and error rather than claiming success. Use `-Minimal` only if GitHub/Azure CLI-dependent features are not needed.

If `winget` is missing, install or update Microsoft's **[App Installer](https://apps.microsoft.com/detail/9NBLGGH4NNS1)** from Microsoft Store, check its **App execution alias** in Windows Settings, then rerun `install.bat`. On managed PCs ask IT to provide App Installer or the prerequisites. No unverified download/bootstrap script is run.

Dependencies are installed from the bundled **`package-lock.json`** with `npm ci --omit=dev --no-audit --no-fund` in a staging folder; the installer verifies MSAL, Copilot SDK and mail module imports before replacing application files. Internet access to the configured npm registry is needed unless those exact packages are cached.

### Safe upgrades

The installer checks both port 8765 ownership and the exact installed Node entry point, including a process that is still starting. A running dashboard, active SQL/authentication child process, or an unrelated listener blocks installation **before any application files are replaced**. It does not kill processes or attempt an automatic restart. Finish/cancel operations, use the installed `Stop-Dashboard.ps1` when idle, and rerun. The newly installed stop command also checks ownership and refuses to terminate a dashboard with active children; it never stops an unrelated port owner.

Upgrades preserve `servers.json`, AI/email settings, Microsoft token metadata/cache, `.encryption-key`, the app-owned `azure-sql-auth` profile folder, and the `history` folder. These are copied **together** into a timestamped `config-backups` subfolder before replacement; existing backups are retained. Keep backups private: they contain encrypted credentials and the account-bound key. The installer rejects payloads containing runtime state, keys, history or preinstalled `node_modules`, so a release cannot overwrite your configuration with the packager's files. A failed staged dependency install leaves the previous application files untouched. Replacement keeps the previous application files and dependency directory until every staged move succeeds. A commit failure restores them; if Windows prevents restoration, the error identifies the retained `.install-rollback-*` recovery folder. Never delete that folder before recovering its files.

### Optional Windows service (explicit opt-in)

Normal installation does **not** register or start a service. Desktop shortcuts and per-user logon startup remain the default. For monitoring while logged out, the installed application includes the complete `SqlPulse.Service.cs` source and explicit service-management scripts. They compile a native .NET Framework Windows service using Windows PowerShell's built-in compiler; no third-party wrapper is downloaded.

1. Configure/test SQL Pulse in your own Windows session and explicitly enable **Keep capturing when the app window is closed** under Settings > Back in Time. Check the automatically saved state. Service registration and every service boot require that persisted approval; email settings are not a substitute. Installing a service never enables monitoring, email, webhooks, or optional diagnostics on your behalf. Then finish/cancel active work and stop the desktop dashboard with `Stop-Dashboard.ps1`.
2. Your Windows account must have a real password and the **Log on as a service** right. A Windows Hello PIN, passwordless-only account, disabled/expired password, or an organizational denial of service logon will not work. Ask your Windows administrator to approve/provide the necessary account right; these scripts do not grant rights or change account policy.
3. Open **Windows PowerShell as administrator using the same Windows account** that owns the configuration, not another administrator's credentials. Run:

```powershell
$app = Join-Path $env:LOCALAPPDATA 'SqlDashboard'
& (Join-Path $app 'Install-Service.ps1') -Credential (Get-Credential) -Start
```

The credential must identify that same Windows SID. The password is passed securely to Windows Service Control Manager, never written to application JSON or native command arguments. Existing DPAPI keys are verified before registration and again under the service identity at startup. **LocalSystem, LocalService, NetworkService, different-user migration, and copying credentials between machines are not supported.** Service mode does not create cloud accounts or grant SQL permissions. `-DataDir <existing-path>` is available for a separate same-user data directory. Without `-Start`, registration configures automatic boot startup but does not start the service immediately.

The service uses the verified absolute Node executable and the owner's profile/tool directories. It disables only this installation's existing desktop logon task to avoid competing hosts; the shortcut can still open a running service's local dashboard. A service start refuses an existing desktop host or occupied port instead of stopping it. Both modes use loopback port 8765. A registered service must be explicitly removed before a normal application upgrade or uninstall.

Node crashes and a stale/missing event-loop heartbeat trigger owned-process restart. The watchdog reads `/health/details` and checks only its process PID and heartbeat freshness; `degraded` SQL/storage status remains visible to the operator and never triggers host restart. A 60-second startup allowance and 45-second heartbeat threshold avoid treating SQL connectivity failures as host failures. Windows Service Control Manager also has automatic restart recovery (5/15/60 seconds) if the wrapper fails. Explicit service stop requests authenticated graceful dashboard shutdown, allows 15 seconds to finish, then closes a Windows process job containing **only its own Node process and descendants**. Application imports are gated until Node belongs to that job. Host/stdout/stderr logs are `service-host.log`, `service-server.log`, and `service-server.err.log` in the installation, each rotated at about 5 MiB with one previous file.

Service sessions cannot display interactive Microsoft/GitHub sign-in windows. Cached tokens can only refresh while the identity provider, tenant policy, token lifetime, and profile access permit it. An expiring Azure CLI session or required OAuth/MFA consent needs an explicit return to the same user's desktop session to sign in; service recovery cannot manufacture authorization. Stop the service explicitly before using the desktop host, and stop the desktop host before restarting the service. While service registration remains, the launcher uses its configured data directory. If you remove service registration with a custom `-DataDir`, set `SQL_DASHBOARD_DATA_DIR` to that directory before returning to desktop mode. SMTP/provider/SQL prerequisites remain unchanged. A watchdog restart is not a guarantee of SQL, email, or cloud availability.

To stop/remove service mode, run the following from the same elevated account:

```powershell
& (Join-Path $app 'Uninstall-Service.ps1')
```

This verifies the registered executable/account, disables service startup, gracefully stops the owned host, and removes service registration only. Configuration, key, history, and the desktop application remain. Desktop logon startup stays disabled until you explicitly opt back in by rerunning the normal installer.

## First run

1. Dashboard opens at **http://127.0.0.1:8765/** and displays the responsible-use disclaimer before first use in that browser
2. First-time installations start with an empty server list; existing configurations are preserved on upgrade
3. Click **+ Add server** to register more:
   - **Windows Integrated** for on-prem SQL Server on the same domain
   - **SQL Server Authentication** for user/password logins
   - **Entra ID - existing shared Azure CLI session** for the legacy shared/global CLI identity (other apps can change it), not Windows SSPI
   - **Entra ID Password** for headless Azure automation
   - **Microsoft browser sign-in (recommended)** for normal Microsoft sign-in without entering a device code
   - **Microsoft device code (alternative)** with a Copy code button and a visible sign-in link

The connection editor distinguishes Azure SQL Database from Managed Instance. Managed Instance does not require a user database; leave the field blank for the login default or type a name directly. Specify the SQL resource tenant for cross-tenant Entra access. Interactive Test/Load verifies the requested account and may launch MFA; background collection never launches sign-in. A connection failure shows the actual diagnostic rather than the raw process command.

Browser/device sign-in persists a SQLPulse-owned Azure CLI profile per normalized account and tenant under `DATA_DIR\azure-sql-auth\<SHA256>`. **The same profile is used for login, token/account verification and actual sqlcmd connectivity to both Azure SQL Database and Managed Instance**, including probes and monitoring. It survives shutdown, upgrades and keep-configuration uninstall backups. Other apps' CLI sign-ins cannot switch this identity. First use requires explicit Test/Load sign-in inside SQLPulse: an existing global CLI login is not imported, copied or used as a fallback. Background token refresh is possible only while Microsoft policy, token lifetime and MFA/Conditional Access permit; use Test/Load again when authorization expires. No Microsoft password is saved. AI/GitHub authentication is unchanged.

Azure SQL/Managed Instance built-in reads allow 30 seconds for SQL login and one fresh-connection retry after five seconds for recognized transient network/service failures. Authentication, permission and certificate failures, command timeouts, SQL actions and custom counters are not automatically replayed. Retrying cannot repair a missing VPN/private route, expired interactive authorization or incorrect SQL permissions. Use the saved connection diagnostic to distinguish these from a SQL service outage.

Interactive authentication no longer relies on a Windows account picker behind the app. Browser sign-in is the default: the button-initiated foreground tab opens the Microsoft account page, with no code to enter. Device-code sign-in is an explicit alternative with **Copy code**. A visible link is available if tabs are blocked. Live progress and **Stop test** prevent silent waits; connection fields remain intact after a failed or cancelled test. A passkey error is controlled by Microsoft; use **Sign in another way** if your tenant offers it.

## Data at rest

- `servers.json` — server registry (no plaintext passwords)
- `ai-settings.json` — per-provider configuration and encrypted AI credentials
- `alert-settings.json` / `alert-state.json` — approved email/webhook configuration, policies and notification history/deduplication
- `monitor-settings.json` — independent monitoring, collection budgets and retention preferences
- `history-series/` — bounded numeric history journals, atomic checkpoints and hourly rollups
- `incident-evidence.json` — explicitly opted-in local incident evidence/settings; SQL text and plans require separate choices
- `operational-reports.json` — local numeric operational summaries and explicitly enabled UTC schedule; retained with configuration backups
- `microsoft-email-auth.json` — app registration/account metadata and encrypted MSAL email token cache
- `azure-sql-auth/` — persistent isolated Azure CLI SQL account/tenant profiles; Azure CLI owns its protected token-cache format. Protect this folder and its backups with Windows account filesystem permissions; never package or share them.
- `.encryption-key` — AES-256 key **wrapped with Windows DPAPI (CurrentUser)**
- Runtime data defaults to the install folder; a configured data directory takes precedence. App-encrypted credentials and email tokens are bound to your Windows account; copying them to another machine/user won't decrypt. Azure CLI profile files have their own CLI-managed protection and authorization lifetime.
- Numeric history, incident evidence and registry metadata are not encrypted. Retention applies to active history/evidence, not retained legacy migration files or installer backups; manage those backups separately.

## Uninstall

Remove an explicitly installed service first as described above. Double-click **`uninstall.bat`**. Uninstall refuses unrelated port owners and active SQL/authentication descendants before changing processes, tasks, or files. You'll be asked whether to keep your server and AI provider configuration (saved with the encryption key into a new timestamped subfolder of `%USERPROFILE%\SqlDashboard-config-backup` if yes, without overwriting earlier backups).

Node.js, go-sqlcmd, GitHub CLI and Azure CLI are left in place — remove them via Windows Installed apps or `winget uninstall` if you don't need them. No ODBC driver is installed by this package.

## AI setup

Open **Settings → Configure AI provider** to configure GitHub Copilot, OpenRouter, Azure AI Foundry / Azure OpenAI, OpenAI, Anthropic, local OpenAI-compatible models, or native Ollama (default). Provider settings and credentials survive upgrades and provider switching. GitHub CLI (`gh`) and Azure CLI (`az`, for Entra SQL authentication) are installed/verified by default; `-Minimal` omits them. Installing a CLI is not authentication: sign in only when you choose that feature. Ollama/models, provider subscriptions, endpoints and API keys are configured separately and are not downloaded or purchased by this installer.

Provider testing sends a generic health-check prompt only. Typing a question automatically prepares a local inline review with destination, privacy warning and expandable exact payload. **Send question** approves that displayed payload without a second confirmation pop-up; cloud and network providers send only the approved SQL context off the machine. See the complete user guide in `docs/README.md` in the release ZIP, or the root README when using source, for endpoint and credential details.

## Fleet, counters and optional email

SQL Pulse starts with **All servers**, a compact overview of saved connections. Click a server card to drill into its detailed charts and contextual **Ask AI** buttons. Every SQL service has a badge. Export has been removed.

Core snapshots are shared for 30 seconds, SQL subprocess concurrency is capped at two, expensive inventory defaults to five minutes, and recent-hour Query Store aggregates default to two minutes. **Back in Time** is embedded in server performance details: choose a time window and scrub the time bar to update the existing visuals. A persistent historical-data banner and **Return to live** keep past and current values distinct. New raw snapshots retain all available performance sections, actual database/file labels, counter definitions and section timestamps/status locally, unencrypted. Detailed cursor lookup is independent of trend downsampling, never a live SQL lookup. Old records and expired raw samples cannot recover missing detail. SQL/schema text uses the existing Incident evidence SQL text opt-in; plan handles use the independent plan opt-in, with XML only where the incident collector actually retained it. Login/host/program identities remain omitted. Revoking consent scrubs retained sensitive visual fields. Limits remain 32 MiB snapshot + 1 MiB journal per server; visual detail is bounded to 384 KiB per sample, 512 rows per section and 20 counters, with explicit truncation. Extra detail may shorten retained coverage. Upgrades preserve existing settings/history; no new runtime store is required. One checkbox enables unattended capture for all unpaused servers; the backend or explicitly installed service must remain running and the host awake, even if the browser/app window is closed. Set **Keep history for (days)** directly under Settings > Back in Time (default 7; 1-90 days). Raw snapshots and summaries use the selected period, subject to disk/point limits. Expired history is purged automatically on save, startup and hourly while running, even for paused/deleted servers. Existing saved periods are preserved until changed. Advanced collection budgets and collector health remain collapsed. Custom counters have separate intervals, templates and pause controls. **Diagnostics** adds optional bounded incident reads, disabled by default. See `docs/README.md` for the audited field map, privacy, permissions and workload limits.

The Back in Time settings dialog has Capture, Summaries, and Health & service tabs. Master/retention changes autosave; advanced collection changes require Save advanced settings. When capture is off, dependent options in every pane are gray and noninteractive, without changing saved summary schedules, notification approvals or Windows services. Header/footer stay visible; long content scrolls only inside its pane.

The inline workload-insights section correlates stored wait intervals, blocking, Query Store regressions and plan identities by source/recorded times, not exact execution order. Sensitive SQL text, deadlock XML and plan XML each require their own opt-in in Incident evidence. Baselines are advisory UTC workload bands with an explicit warmup; static alerts remain unchanged. Historical comparisons end at the selected cursor. Settings > Back in Time > Summaries also offers local operational summaries and JSON downloads, with daily or Monday-weekly generation at a labeled UTC hour, **disabled by default**. The backend must be running; only the latest missed slot is generated after restart. No emails/webhooks are sent. Reports retain only numeric summaries/counts, bounded to 30 reports / 90 days / 2 MiB. Uninstall backups include report configuration/history alongside other settings.

Configure recipients and an authorized SMTP sender under **Settings → Email alerts**. For Outlook.com or Microsoft 365, select Microsoft sign-in (OAuth2) and supply your own Application (client) ID; the dialog includes app-registration instructions for delegated SMTP.Send and the desktop localhost callback. No Microsoft password or client secret is used. Other SMTP providers retain password/relay mode. Email remains disabled until the user previews and explicitly approves recipients, triggers and message templates. Detection follows periodic polling—not instant SQL push—and requires the monitoring computer to stay awake with SQL Pulse running. SMTP credentials and the Microsoft token cache are encrypted; uncertain sends are not blindly retried. Uninstall backup includes email settings, token cache and deduplication state with the encryption key.

Prerequisite repair cannot bypass email or tenant security. Microsoft email still needs a user-owned OAuth app registration, appropriate delegated permission/tenant consent, and SMTP AUTH allowed by the mailbox administrator. Gmail typically requires two-step verification and a user-created app password (where permitted). You must enter/authorize those settings yourself; the installer never collects passwords, creates registrations, grants consent, or enables email alerts.

Under **Email content**, select **Diagnostic evidence and read-only next checks** and preview/approve to include numeric condition details, thresholds, freshness, potential impact and troubleshooting checks. Existing approvals remain generic until a new diagnostic approval. Examples and delivery tests use invented data. SQL text, plans, database names, endpoints, login identities and error strings are not included; display names are a separate opt-in. Webhooks remain generic.

## Disclaimer

This independent project is provided as-is under the MIT License; it is not an official Microsoft or GitHub product. The first-run notice covers production safety, least-privilege permissions, the state-changing Kill Session action, AI inaccuracies and data disclosure, provider charges, and local data protection. Reopen the full notice with **About and disclaimer** at any time. Acknowledgement never authorizes SQL actions or AI data transfers.

## Troubleshooting

**Dashboard doesn't open**
- Check `%LOCALAPPDATA%\SqlDashboard\server.log` and `server.err.log`
- Run manually: `powershell -File "%LOCALAPPDATA%\SqlDashboard\Start-Dashboard.ps1"`

**Connection test fails**
- Verify the SQL Server is reachable: `sqlcmd -S <server> -E -Q "SELECT 1"`
- For Azure SQL Database, check firewall rules for your client IP
- For Entra ID, make sure your account has been granted SQL access to the database

**Port 8765 already in use**
- Do not kill an arbitrary port owner. The installer identifies an unrelated application and refuses to proceed.
- If it is your installed SQL Pulse, finish/cancel active SQL/authentication work and run `powershell -File "%LOCALAPPDATA%\SqlDashboard\Stop-Dashboard.ps1"`, then retry installation.

**Prerequisite repair fails**
- Read the exact package/version failure above **INSTALL COMPLETE** (which is shown only after success).
- Install/update Microsoft App Installer; check network access to WinGet/npm and any administrator or organizational restrictions.
- Rerun the installer after correcting the restriction. Use `-Minimal` only to omit CLI-dependent optional features, not to bypass Node/sqlcmd failures.

**No data on Azure SQL DB**
- Enable Query Store: `ALTER DATABASE <name> SET QUERY_STORE = ON;`
- Grant your login `VIEW DATABASE STATE` permission
