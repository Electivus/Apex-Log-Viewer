# Windows lab

`scripts/windows-lab.js` runs real Windows x64 on demand on Azure, so that you can validate Windows-only work from a Mac. Docker on an arm64 Mac cannot run Windows containers. The lab costs nothing after `destroy`.

## Requirements

- macOS, because the password goes in the Keychain.
- The Azure CLI, signed in to the subscription.
- `az bicep install`.

## Commands

| Command                                  | Result                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `node scripts/windows-lab.js up`         | Converge the lab, restart a stopped VM, set the auto-shutdown, and allow only your current public IP.     |
| `node scripts/windows-lab.js ssh -- cmd` | Run a command in Git Bash on the VM. Without a command, open a shell. `--tty` asks for a pseudo-terminal. |
| `node scripts/windows-lab.js rdp`        | Open an RDP connection file and print the Keychain command that copies the password.                      |
| `node scripts/windows-lab.js status`     | Show the VM state, the auto-shutdown time and every resource in the group.                                |
| `node scripts/windows-lab.js down`       | Deallocate the VM and delete the public IP. The OS disk stays and bills.                                  |
| `node scripts/windows-lab.js destroy`    | Delete the group. Nothing in the group bills after this.                                                  |

`up` options:

- `--ref <git-ref>` moves the checkout on the VM to a branch, tag, commit or `refs/pull/<n>/head`. The VM refuses to move a dirty checkout. The ref must be on GitHub.
- `--hours <n>` sets the auto-shutdown to `n` hours from now, from 0.25 to 23. The default is 4. Rerun `up` to extend a session.
- `--size <vm-size>` selects another size.

Every command also takes `--location <region>` and `--resource-group <name>`. The group name must match `rg-alv-windows-lab-<region>`. Every command refuses any other name, and `destroy` also requires the tag `alv-lab=windows`.

The checkout is at `/c/alv-lab/repo`:

```bash
node scripts/windows-lab.js up --ref my-branch
node scripts/windows-lab.js ssh -- 'cd /c/alv-lab/repo && pnpm install --frozen-lockfile && pnpm run test:core'
node scripts/windows-lab.js destroy
```

For a long command, see [Known limits](#known-limits).

## `destroy` or `down`

Use `destroy` by default. This project uses the lab sporadically, and `destroy` is the only state with no cost at rest.

| State after you finish         | Cost at rest       | Next session reaches a ready checkout in                                       |
| ------------------------------ | ------------------ | ------------------------------------------------------------------------------ |
| `destroy`                      | 0 USD in the group | About 10 minutes: `up` 305 to 329 s in 4 runs, and a cold `pnpm install` 286 s |
| `down`                         | 4.80 USD a month   | 305 s (one run, before a fix that removes a 96 s step). `node_modules` stays   |
| The guard fired, and no `down` | 8.45 USD a month   | The same as `down`                                                             |

Measured on 2026-11-07 in `eastus`, on `Standard_D4s_v4`. Prices are from the Azure retail price API: the E6 disk is 4.80 USD a month, and the Standard static public IP is 0.005 USD an hour, which is 3.65 USD a month at 730 hours. A running VM is 0.376 USD an hour on demand, plus the public IP. `down` took 44 s in one run. `destroy` took 195 to 197 s in 3 runs. Rerunning `up` on a running VM took 78 s and 110 s.

`destroy` costs about 5 more minutes per session than `down`. `down` costs 0.16 USD a day.

Use `down` when you come back within a few days and want to keep `node_modules` and other state on the VM.

## What the cost guard does not cover

Each `up` sets an Azure auto-shutdown that deallocates the VM. The deployment holds the VM and the schedule together, so ARM creates the schedule even if your Mac dies after it submits. In a test, a schedule armed for 3 minutes ahead deallocated the VM within about a minute of its time. The guard does not cover these cases:

- **The disk and the public IP.** The guard deallocates only the VM. After it fires, the OS disk and the public IP keep billing until you run `down` or `destroy`.
- **A Mac that dies during `up`.** The schedule is a daily time. If that time passes while `up` runs, `up` deallocates the VM and fails. If the Mac dies first, the VM can run until that time comes again.
- **A manual start.** The schedule is a daily time of day. If you start the VM from the portal or with `az vm start`, it runs until that time comes again, which can be almost 24 hours. Start it with `up`.
- **A schedule that someone changes or disables.** `status` shows the schedule. It warns only when the schedule is absent.
- **A failure in the Azure scheduler.** Azure does not guarantee when the schedule fires.

## Differences from `windows-latest`

The lab matches the runner image `windows-2025-vs2026` on the OS (Windows Server 2025 Datacenter, build 26100), Git for Windows, the Git installer options, `core.autocrlf=false`, `safe.directory=*`, long paths, the `.nvmrc` Node release on x64, 4 vCPU and 16 GB. It differs in these ways:

- **Defender.** The lab keeps real-time protection on. The runner image turns it off. Defender does not block the work, but it slows it. See [Defender](#defender).
- **Disk.** The checkout is on a 64 GB Standard SSD (E6) C: drive. CI checks out on D:.
- **pnpm store.** The lab starts with a cold store. CI restores a cache.
- **Tools.** The lab has only what its bootstrap installs. The runner image has much more.
- **Windows Update.** The VM has automatic updates off, so that no reboot lands in a test loop.

## Defender

Measured on the same VM, with the runs alternated:

| Work                              | Defender on         | Defender off     |
| --------------------------------- | ------------------- | ---------------- |
| `pnpm run test:core`, 3 runs each | 89 s, 92 s, 95 s    | 75 s, 61 s, 62 s |
| `pnpm install` with a cold store  | 276 s, 285 s, 286 s | 175 s, 166 s     |

With Defender on, `MsMpEng` holds about 3.5 of the 4 cores during the install, and the CPU limits it. With Defender off, CPU use is 15% and the E6 disk limits the install, at about 600 operations a second. A flaky test that depends on timing can behave differently here than in CI. To compare, run `Set-MpPreference -DisableRealtimeMonitoring $true` on the VM.

## Size and Spot

The lab runs `Standard_D4s_v4` on demand. `standardDSv5Family` has a quota of 0 on this subscription, and `Standard_D4s_v4` has the same retail price as `Standard_D4s_v5`. The lab does not use Spot, because 4 vCPU exceeds the subscription's Spot limit of 3 (`lowPriorityCores`). A 4-hour session costs about 1.52 USD.

## Security

- Inbound traffic is allowed only on ports 22 and 3389, and only from the public IP that ran the last `up`. If your IP changes, rerun `up`.
- SSH uses a key in `~/.config/alv-windows-lab`, and the server offers only `publickey`. The script takes the host key from the VM through `az vm run-command`, so the first connection does not trust an unverified key.
- A random password for RDP goes only to the macOS Keychain, in the service `alv-windows-lab`, with the lab group as the account, so destroying one lab leaves the password of another.
- The script hides subscription IDs and IP addresses in the errors it prints.
- The bootstrap checks the SHA-256 of Git for Windows against a pinned value, and of Node against `SHASUMS256.txt` from nodejs.org. Corepack checks the pnpm package.

## Known limits

- **A long command can stall over SSH.** In 2 of 5 cold installs over SSH, `pnpm install` printed `Done` and the shell did not run the next command, for at least 18 and 44 minutes. The cause is not known. A job that WMI starts is outside the SSH session, and it survives a restart of your Mac. Upload a script that sets `HOME`, `USERPROFILE`, `LOCALAPPDATA` and `APPDATA` and writes its output to a file, then run this PowerShell on the VM from a `.ps1` file:

  ```powershell
  Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '"C:\Program Files\Git\bin\bash.exe" /c/alv-lab/job.sh' }
  ```

- **SSH has no console window.** A check that depends on a real terminal or on a fresh Git Bash window needs `rdp`.
- **`NetworkWatcherRG` stays.** Azure creates this group by itself when the first virtual network appears in a region. `destroy` refuses to touch it, because it is outside the lab.
