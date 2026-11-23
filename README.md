# Naukri Profile Scheduler

A local Windows app that runs a verified update on your own Naukri profile and tracks the result in a dashboard. Each cycle opens **Basic details**, adds a period to the **Name** field, saves, then restores and verifies the exact original name. The two saves count as one completed update.

Setup is required on each computer. The repository supplies the application and installer. You supply your own browser login, page selectors, and validation results.

## How it works

| Component | Job |
| --- | --- |
| **Windows Task Scheduler** | Starts the Node.js worker in your signed-in Windows session. A companion task records sign-in and wake events. A five-minute backup trigger starts the worker if needed. |
| **Node.js worker** | Checks the On/Off setting, validation, and saved attempt limits before opening a browser. It records results and prioritizes restoring the original name if a cycle is interrupted. |
| **Playwright + Chrome or Edge** | Uses a dedicated browser session to open the profile editor, perform the two saves, and verify the restored value. |
| **Local dashboard** | Shows worker status, update totals, failures, and pending recovery. The worker can run after you close the dashboard. |

Windows launches the worker, and Node.js decides when a profile update is eligible. Your browser session, settings, and run history stay in the project on your computer.

## 1. Install on Windows

You need **Windows**, **PowerShell**, **Node.js 22 or newer** with npm, and **Google Chrome or Microsoft Edge**. Download the repository ZIP from GitHub and extract it to a folder you own, or clone it with Git. Open PowerShell in the project folder, where `package.json` is located.

```powershell
npm ci
if (-not (Test-Path config.local.json)) {
    Copy-Item config.example.json config.local.json
}
```

Keep the checkout at a stable path once you install the Windows tasks. Their actions point to this folder.

## 2. Connect your browser and configure the editor

Open `config.local.json`. Set `enabled` to `false` during setup, choose `chrome` or `msedge` for `browserChannel`, and choose a browser mode. With `headless: false`, the browser window can appear during a run. With `headless: true`, it runs without a window.

```powershell
npm run login
npm run inspect
```

Sign in manually in the dedicated browser. Click **Resume** in Playwright Inspector when finished. Use the inspector to identify the selectors on your own authenticated profile. The example leaves these blank because they need to match the actual page.

| Setting | What it identifies |
| --- | --- |
| `edit` | The Edit control in the top profile card |
| `editor` | The dialog container for **Basic details** |
| `name`, `close`, `save` | The Name input, close control, and Save button inside that dialog. Use a CSS selector for `name`. |
| `heading` | Optional selector inside the dialog when **Basic details** is plain text rather than an accessible heading |
| `success` | The fresh success message, required in the default `toast-and-editor` confirmation mode |
| `challenge`, `validationError` | Optional page selectors for authentication challenges and validation errors |

For a redacted list of controls, use `npm run inspect -- --report`. If saves do not display a repeat confirmation message, the `persisted-editor` confirmation mode verifies the value by reopening the profile. See the [setup guide](docs/SUPERVISED-VALIDATION.md) for details.

## 3. Verify before scheduling

Run `npm run check-setup`, then choose **one** read-only check for the mode in your config.

```powershell
npm run verify                 # headless: false
npm run verify -- --background # headless: true
```

The read-only check opens the editor without saving. In live testing, Naukri returned HTTP 403 for headless Chrome while the visible check passed. If your chosen mode fails, resolve it before continuing. If you switch modes, validate the mode you intend to run.

Once the read-only check passes and you have confirmed Naukri permits the workflow, set `permissionConfirmed` and `enabled` to `true`. Run the supervised check once.

```powershell
npm run verify-save
npm run status
```

This makes real profile edits in the configured browser mode. Confirm the original name is restored and that `npm run check-setup` reports `liveChecksPassed: true`. If the attempt fails or restoration is pending, resolve it before enabling the schedule. Set `enabled` back to `false` until you are ready to turn on scheduled updates.

## 4. Install and confirm the schedule

From the project folder, run the permissions script and installer as the Windows user who will run the workflow. The permissions script restricts access to the checkout and its browser session.

```powershell
.\scripts\protect-project.ps1
.\scripts\install-task.ps1
Get-ScheduledTask -TaskName 'NaukriProfileScheduler*'
npm run dashboard
```

Expect two Windows tasks, **NaukriProfileScheduler** and **NaukriProfileScheduler-Session**. Open the dashboard at [http://127.0.0.1:4317](http://127.0.0.1:4317), check that the worker is active, and turn the workflow **On**. Use the next eligible time and recent activity to check the first scheduled result. The worker runs in your signed-in Windows session while the computer is awake.

The five-minute backup trigger checks whether the worker needs to start. It is separate from the profile update schedule. During normal scheduled operation, the worker selects the next 35–45 minute interval and stores it locally. Sign-in or wake can signal a fresh cycle when the saved state allows it. The worker checks pending restoration and retry limits first.

## Daily use and troubleshooting

| If you want to… | Do this |
| --- | --- |
| Stop future updates | Turn **Off** in the dashboard. A cycle already in progress may finish restoring the name. |
| Check a failure or pending restoration | Run `npm run status`. When eligible, `npm run recover` attempts restoration only. |
| Refresh an expired login | Run `npm run login` and complete any verification prompt yourself. |
| Change the browser, mode, or selectors | Run the matching read-only check and supervised validation again. |
| Pause or remove the Windows tasks | Use `.\scripts\install-task.ps1 -Pause` to pause the worker, `-Resume` to resume, or `-Remove` to uninstall the tasks. |

A transient failure can receive one retry after at least 60 seconds. Security challenges, access restrictions, and conflicting profile changes stop automatic retries. If a run is interrupted between saves, the period can remain visible until restoration succeeds.

Keep `config.local.json` and `.local/` private. Each computer needs its own login and validation. Use one active computer per account because run limits are stored locally.

[Detailed operation and uninstall guide](docs/OPERATION.md) · [System architecture](docs/ARCHITECTURE.md) · [Retry and recovery rules](docs/RETRY-POLICY.md)
