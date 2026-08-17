# Running on a free-tier GCP VM

Runs the poller on an `e2-micro` instance instead of your laptop, so it stays up without you
needing your machine on. GCP's free tier includes one `e2-micro` per month at no cost, as long
as the settings below are followed - deviating from them (wrong disk type, wrong region) is
what turns this into a paid instance.

## Free tier requirements

- **Machine type**: `e2-micro`
- **Region**: one of `us-west1`, `us-central1`, `us-east1` (any zone within it)
- **Boot disk**: **Standard persistent disk** (not Balanced, not SSD), up to 30 GB
- **Snapshot schedule**: None

Getting the disk type wrong is the most common way this stops being free - the console
defaults to "Balanced persistent disk," which is not covered by the free tier.

## 1. Create the VM

In the GCP Console under Compute Engine -> VM instances -> Create instance:

1. **Name**: anything, e.g. `restaurant-waitlist-vm`
2. **Region**: `us-west1` (or `us-central1`/`us-east1`) - **Zone**: leave as "Any"
3. **Machine configuration**: `e2-micro`
4. **OS and storage** -> click the boot disk -> set:
   - OS: Ubuntu 22.04 LTS (or the Minimal variant)
   - Disk type: **Standard persistent disk**
   - Size: 30 GB
5. Leave firewall checkboxes (HTTP/HTTPS) unchecked - this isn't a web server
6. Click **Create**

Confirm the monthly estimate reads close to $0 before creating. If it still shows a
non-trivial cost, re-check disk type and region against the list above.

## 2. Connect

Click the **SSH** button next to the instance in the console list - opens a browser-based
terminal, no key setup needed.

## 3. Install Node and Playwright's system dependencies

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git tmux
```

## 4. Copy the code over

`gcloud compute scp --recurse` is very slow on this repo because of `node_modules` (thousands
of small files). Pipe a `tar` over SSH instead, excluding `node_modules`/`.git`/`screenshots` -
`node_modules` gets reinstalled fresh on the VM in step 5 anyway (Linux binaries differ from
your Mac's build regardless, so copying it would be wasted even if fast).

From your laptop, in the repo root:

```bash
scripts/deploy.sh
```

That is the same tar-over-SSH pipe, wrapped up with the zone, instance and project baked in -
see [Deploying changes](#deploying-changes) below for what it does and its flags.

It also copies any local `credentials.json` / `token.json` / `state.json` if present, which
on a first deploy is what you want - it avoids redoing the OAuth flow on the VM.

## 5. Install dependencies on the VM

```bash
cd ~/book-restaurant
npm install
sudo npx playwright install-deps chromium
npx playwright install chromium
```

## 6. Run it persistently

An SSH session ends when the browser tab closes, which would kill a plain `npm run
poll:watch`. Use `tmux` so it survives:

```bash
tmux new -s poll
npm run poll:watch
```

Detach with `Ctrl+B` then `D` - the process keeps running. Reattach later with:

```bash
tmux attach -t poll
```

## Deploying changes

`scripts/deploy.sh` pushes the local working tree to the VM. It defaults to the instance this
repo actually uses (`restaurant-waitlist-vm`, `us-east1-c`, project `reservation-waitlist-checker`)
and always passes `--project` explicitly, because the active `gcloud` project is usually an
unrelated work project.

```bash
scripts/deploy.sh              # sync everything, including secrets and state
scripts/deploy.sh --dry-run    # list what would be sent, touch nothing
scripts/deploy.sh --code-only  # skip credentials.json / token.json / state.json / .env
scripts/deploy.sh --no-install # skip npm install on the VM
```

Override the target with `--zone` / `--instance` / `--project`, or the `VM_ZONE` / `VM_INSTANCE` /
`VM_PROJECT` / `VM_REMOTE_DIR` env vars.

What it does, in order: checks the instance exists and is `RUNNING` (so a wrong zone fails before
any transfer), backs up the VM's `token.json` and `state.json` to `.bak-<timestamp>` copies, pipes
the tree over as a tar excluding `node_modules`/`.git`/`logs`/`screenshots`, then runs `npm install`
on the VM.

**It does not restart the poller.** The VM keeps running the old code until you restart it yourself -
the script prints the commands. This is deliberate: a restart can land mid-`claimSpot`, killing a
browser run that has already opened a confirm link, which loses the spot with nothing recorded in
`state.json`. Restarting by hand means choosing a moment when nothing is in flight (the log is quiet,
showing `no new waitlist emails`).

Two things to know about the default "send everything" behaviour:

- `token.json` is rotated on the VM every hour as the access token refreshes. Pushing a stale local
  copy replaces a newer VM token. Still valid (the refresh token is what matters) but the backup is
  there if a deploy breaks auth: `cp token.json.bak-<timestamp> token.json`.
- `state.json` on the VM holds the real booking history, which your laptop's copy does not have.
  Overwriting it can make the bot re-attempt an event it already booked. Use `--code-only` for any
  deploy after the first, unless you specifically want to reset VM state.

## Checking on it

SSH in (`gcloud compute ssh restaurant-waitlist-vm --zone=us-east1-c --project reservation-waitlist-checker`), then:

```bash
tmux attach -t poll          # reattach to the running session, watch it live
```

`Ctrl+B` then `D` to detach again without stopping it.

To check without attaching (doesn't disturb the running session):

```bash
tail -f ~/book-restaurant/logs/$(date +%F).log     # follow today's log live
tail -100 ~/book-restaurant/logs/$(date +%F).log   # last 100 lines
ls ~/book-restaurant/logs/                         # see all dated log files
cat ~/book-restaurant/state.json                   # what's been booked/attempted so far
tmux ls                                            # confirm the poll session is still running
```

One-liner from your laptop, no SSH session to manage:

```bash
gcloud compute ssh restaurant-waitlist-vm --zone=us-east1-c --project reservation-waitlist-checker --command="tail -50 ~/book-restaurant/logs/\$(date +%F).log"
```

## Notes

- If `credentials.json`/`token.json` weren't copied over in step 4, run `npm run auth` on the
  VM instead and complete the OAuth flow there.
- The OAuth refresh token still expires every 7 days regardless of where this runs (see main
  [README](../README.md#auth-token-expiry-running-for-multiple-days)) - re-run `rm token.json
  && npm run auth` on the VM when it does.
- This VM approach is a stopgap. The [README's "next step" section](../README.md#next-step-move-off-local-polling-to-gmail-push-cloud-run--pubsub)
  covers moving to a push-based, scale-to-zero Cloud Run setup instead of an always-on VM.
