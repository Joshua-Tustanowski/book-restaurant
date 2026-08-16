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

From your laptop, in the repo root (swap the zone for whatever the VM actually landed in):

```bash
tar --exclude='node_modules' --exclude='.git' --exclude='screenshots' \
  -czf - -C /Users/joshwork/Dropbox/Mac/Desktop/dev/local-projects/local_hacks/book-restaurant . \
  | gcloud compute ssh restaurant-waitlist-vm --zone=us-east1-b --command="mkdir -p ~/book-restaurant && tar -xzf - -C ~/book-restaurant"
```

This also copies any local `credentials.json` / `token.json` / `state.json` if present, which
is what you want - it avoids redoing the OAuth flow on the VM.

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

## Notes

- If `credentials.json`/`token.json` weren't copied over in step 4, run `npm run auth` on the
  VM instead and complete the OAuth flow there.
- The OAuth refresh token still expires every 7 days regardless of where this runs (see main
  [README](../README.md#auth-token-expiry-running-for-multiple-days)) - re-run `rm token.json
  && npm run auth` on the VM when it does.
- This VM approach is a stopgap. The [README's "next step" section](../README.md#next-step-move-off-local-polling-to-gmail-push-cloud-run--pubsub)
  covers moving to a push-based, scale-to-zero Cloud Run setup instead of an always-on VM.
