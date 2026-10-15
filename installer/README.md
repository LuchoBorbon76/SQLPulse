# SQL Pulse — Installer

A live, multi-instance SQL Server performance dashboard powered by DMVs and Query Store, with support for on-prem SQL Server, Azure SQL Database, and Azure SQL Managed Instance.

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
| **Azure CLI (`az`)** | Entra SQL authentication using an existing Azure CLI session; checked by default, omitted with `-Minimal` | `Microsoft.AzureCLI` |

Requires Windows PowerShell **5.1+** on Windows 10/11 with Windows Package Manager available. If every required tool is already usable, no package installation is attempted. The installer probes real executable versions (not just filenames), rejects old/ODBC sqlcmd, refreshes machine/user PATH while retaining session-only paths, and discovers standard and WinGet installation locations. It uses the selected Node's `npm.cmd` immediately, without reopening the terminal or depending on an npm PowerShell execution-policy exception.

Repairs use exact package IDs from the `winget` source, first at user scope, then at package-default scope if necessary. Some packages only support machine scope and may trigger Windows UAC; use `-UserScopeOnly` to prevent that fallback. The application itself stays per-user. Offline/managed systems may require IT-approved installation; if a selected tool still fails its version probe after repair, installation stops with the package ID and error rather than claiming success. Use `-Minimal` only if GitHub/Azure CLI-dependent features are not needed.

If `winget` is missing, install or update Microsoft's **[App Installer](https://apps.microsoft.com/detail/9NBLGGH4NNS1)** from Microsoft Store, check its **App execution alias** in Windows Settings, then rerun `install.bat`. On managed PCs ask IT to provide App Installer or the prerequisites. No unverified download/bootstrap script is run.

Dependencies are installed from the bundled **`package-lock.json`** with `npm ci --omit=dev --no-audit --no-fund` in a staging folder; the installer verifies MSAL, Copilot SDK and mail module imports before replacing application files. Internet access to the configured npm registry is needed unless those exact packages are cached.

### Safe upgrades

The installer checks both port 8765 ownership and the exact installed Node entry point, including a process that is still starting. A running dashboard, active SQL/authentication child process, or an unrelated listener blocks installation **before any application files are replaced**. It does not kill processes or attempt an automatic restart. Finish/cancel operations, use the installed `Stop-Dashboard.ps1` when idle, and rerun. The newly installed stop command also checks ownership and refuses to terminate a dashboard with active children; it never stops an unrelated port owner.

Upgrades preserve `servers.json`, AI/email settings, Microsoft token metadata/cache, `.encryption-key`, and the `history` folder. These are copied **together** into a timestamped `config-backups` subfolder before replacement; existing backups are retained. Keep backups private: they contain encrypted credentials and the account-bound key. The installer rejects payloads containing runtime state, keys, history or preinstalled `node_modules`, so a release cannot overwrite your configuration with the packager's files. A failed staged dependency install leaves the previous application files untouched.

## First run

1. Dashboard opens at **http://127.0.0.1:8765/** and displays the responsible-use disclaimer before first use in that browser
2. First-time installations start with an empty server list; existing configurations are preserved on upgrade
3. Click **+ Add server** to register more:
   - **Windows Integrated** for on-prem SQL Server on the same domain
   - **SQL Server Authentication** for user/password logins
   - **Entra ID - existing Azure CLI session** for a verified cached CLI identity, not Windows SSPI
   - **Entra ID Password** for headless Azure automation
   - **Microsoft browser sign-in (recommended)** for normal Microsoft sign-in without entering a device code
   - **Microsoft device code (alternative)** with a Copy code button and a visible sign-in link

The connection editor distinguishes Azure SQL Database from Managed Instance. Managed Instance does not require a user database; leave the field blank for the login default or type a name directly. Specify the SQL resource tenant for cross-tenant Entra access. Interactive Test/Load verifies the requested account and may launch MFA; background collection never launches sign-in. A connection failure shows the actual diagnostic rather than the raw process command.

Interactive authentication no longer relies on a Windows account picker behind the app. Browser sign-in is the default: the button-initiated foreground tab opens the Microsoft account page, with no code to enter. Device-code sign-in is an explicit alternative with **Copy code**. A visible link is available if tabs are blocked. Live progress and **Stop test** prevent silent waits; connection fields remain intact after a failed or cancelled test. A passkey error is controlled by Microsoft; use **Sign in another way** if your tenant offers it.

## Data at rest

- `servers.json` — server registry (no plaintext passwords)
- `ai-settings.json` — per-provider configuration and encrypted AI credentials
- `alert-settings.json` / `alert-state.json` — approved email configuration and notification history/deduplication
- `microsoft-email-auth.json` — app registration/account metadata and encrypted MSAL email token cache
- `.encryption-key` — AES-256 key **wrapped with Windows DPAPI (CurrentUser)**
- These files live in the install folder; encrypted credentials and tokens are bound to your Windows account
- Copying them to another machine / user won't decrypt

## Uninstall

Double-click **`uninstall.bat`**. You'll be asked whether to keep your server and AI provider configuration (saved with the encryption key to `%USERPROFILE%\SqlDashboard-config-backup` if yes).

Node.js, go-sqlcmd, GitHub CLI and Azure CLI are left in place — remove them via Windows Installed apps or `winget uninstall` if you don't need them. No ODBC driver is installed by this package.

## AI setup

Open **Settings → Configure AI provider** to configure GitHub Copilot, OpenRouter, Azure AI Foundry / Azure OpenAI, OpenAI, Anthropic, local OpenAI-compatible models, or native Ollama (default). Provider settings and credentials survive upgrades and provider switching. GitHub CLI (`gh`) and Azure CLI (`az`, for existing-session Entra SQL authentication) are installed/verified by default; `-Minimal` omits them. Installing a CLI is not authentication: sign in only when you choose that feature. Ollama/models, provider subscriptions, endpoints and API keys are configured separately and are not downloaded or purchased by this installer.

Provider testing sends a generic health-check prompt only. **Send question** prepares a review and foreground confirmation before any AI request; cloud and network providers send only the approved SQL context off the machine. See the complete user guide in `docs/README.md` in the release ZIP, or the root README when using source, for endpoint and credential details.

## Fleet, counters and optional email

SQL Pulse starts with **All servers**, a compact overview of saved connections. Click a server card to drill into its detailed charts and contextual **Ask AI** buttons. Every SQL service has a badge. Export has been removed.

Core snapshots are shared for 30 seconds, SQL subprocess concurrency is capped at two, expensive inventory runs every five minutes, and recent-hour Query Store aggregates run every two minutes. Custom counters have separate intervals, templates and pause controls.

Configure recipients and an authorized SMTP sender under **Settings → Email alerts**. For Outlook.com or Microsoft 365, select Microsoft sign-in (OAuth2) and supply your own Application (client) ID; the dialog includes app-registration instructions for delegated SMTP.Send and the desktop localhost callback. No Microsoft password or client secret is used. Other SMTP providers retain password/relay mode. Email remains disabled until the user previews and explicitly approves recipients, triggers and message templates. Detection follows periodic polling—not instant SQL push—and requires the monitoring computer to stay awake with SQL Pulse running. SMTP credentials and the Microsoft token cache are encrypted; uncertain sends are not blindly retried. Uninstall backup includes email settings, token cache and deduplication state with the encryption key.

Prerequisite repair cannot bypass email or tenant security. Microsoft email still needs a user-owned OAuth app registration, appropriate delegated permission/tenant consent, and SMTP AUTH allowed by the mailbox administrator. Gmail typically requires two-step verification and a user-created app password (where permitted). You must enter/authorize those settings yourself; the installer never collects passwords, creates registrations, grants consent, or enables email alerts.

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
