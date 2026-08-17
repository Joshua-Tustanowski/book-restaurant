#!/usr/bin/env bash
#
# Pushes the local working tree to the GCP VM that runs the poller.
# See usage() below, or run with --help.

set -euo pipefail

# The active gcloud project is usually something else entirely (a work project),
# so --project is always passed explicitly rather than relying on the default.
VM_INSTANCE="${VM_INSTANCE:-restaurant-waitlist-vm}"
VM_ZONE="${VM_ZONE:-us-east1-c}"
VM_PROJECT="${VM_PROJECT:-reservation-waitlist-checker}"
VM_REMOTE_DIR="${VM_REMOTE_DIR:-book-restaurant}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Rebuilt on the VM: Linux Chromium/native binaries differ from the Mac build, and
# these are either huge (node_modules) or the VM's own output (logs, screenshots).
ALWAYS_EXCLUDE=(node_modules .git screenshots logs)

# Local-only by default in --code-only mode. credentials.json and token.json are
# secrets; state.json is booking history the VM is actively writing.
SECRET_FILES=(credentials.json token.json state.json .env)

code_only=false
dry_run=false
do_install=true

die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }
say() { printf '==> %s\n' "$*"; }

usage() {
  cat <<'EOF'
Pushes the local working tree to the GCP VM that runs the poller.

Sync only: the running poller is left alone, so the VM keeps executing the OLD
code until you restart it by hand. The restart commands are printed at the end.

Usage:
  scripts/deploy.sh                 # sync everything, including secrets and state
  scripts/deploy.sh --code-only     # skip credentials.json / token.json / state.json / .env
  scripts/deploy.sh --dry-run       # show what would be sent, touch nothing
  scripts/deploy.sh --no-install    # skip npm install on the VM
  scripts/deploy.sh --zone Z --instance NAME --project ID

Env var equivalents: VM_ZONE, VM_INSTANCE, VM_PROJECT, VM_REMOTE_DIR.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --code-only)  code_only=true; shift ;;
    --dry-run)    dry_run=true; shift ;;
    --no-install) do_install=false; shift ;;
    --zone)       VM_ZONE="${2:?--zone needs a value}"; shift 2 ;;
    --instance)   VM_INSTANCE="${2:?--instance needs a value}"; shift 2 ;;
    --project)    VM_PROJECT="${2:?--project needs a value}"; shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    *)            die "unknown argument: $1 (try --help)" ;;
  esac
done

command -v gcloud >/dev/null || die "gcloud not found on PATH"
command -v tar >/dev/null || die "tar not found on PATH"

gcloud_vm() {
  gcloud compute ssh "$VM_INSTANCE" \
    --zone "$VM_ZONE" --project "$VM_PROJECT" --command "$1"
}

# Fail here rather than halfway through a transfer if the zone or instance is wrong.
say "checking $VM_INSTANCE ($VM_ZONE, $VM_PROJECT)"
status="$(gcloud compute instances describe "$VM_INSTANCE" \
  --zone "$VM_ZONE" --project "$VM_PROJECT" \
  --format='value(status)' 2>/dev/null)" \
  || die "can't reach $VM_INSTANCE in $VM_ZONE/$VM_PROJECT - check --zone/--instance/--project"

[[ "$status" == "RUNNING" ]] || die "instance is $status, not RUNNING"

# Build the exclude list and report what's being sent, so "everything" is a visible
# choice rather than a silent one.
tar_excludes=()
for pattern in "${ALWAYS_EXCLUDE[@]}"; do
  tar_excludes+=("--exclude=./$pattern")
done

if $code_only; then
  for f in "${SECRET_FILES[@]}"; do
    tar_excludes+=("--exclude=./$f")
  done
  say "code only - not sending: ${SECRET_FILES[*]}"
else
  sending=()
  for f in "${SECRET_FILES[@]}"; do
    [[ -e "$REPO_ROOT/$f" ]] && sending+=("$f")
  done
  if [[ ${#sending[@]} -gt 0 ]]; then
    say "sending secrets/state, will OVERWRITE on VM: ${sending[*]}"
    say "    (VM copies are backed up first; --code-only skips them entirely)"
  fi
fi

if $dry_run; then
  say "dry run - files that would be sent:"
  tar "${tar_excludes[@]}" -cf - -C "$REPO_ROOT" . | tar -tf - \
    | sed 's|^\./||' | grep -v '/$' | grep -v '^$' | sort
  say "dry run - nothing was sent, VM untouched"
  exit 0
fi

# token.json rotates on the VM every hour and state.json accumulates real booking
# history there, so a stale local copy can lose VM-side data. Back both up before
# overwriting, keyed by timestamp so repeated deploys don't clobber the backup.
if ! $code_only; then
  stamp="$(date +%Y%m%d-%H%M%S)"
  say "backing up VM token.json/state.json (suffix .bak-$stamp)"
  gcloud_vm "cd ~/$VM_REMOTE_DIR 2>/dev/null || exit 0
    for f in token.json state.json; do
      [ -f \"\$f\" ] && cp -p \"\$f\" \"\$f.bak-$stamp\" && echo \"backed up \$f\"
    done" || die "backup step failed - nothing was overwritten"
fi

say "syncing working tree to ~/$VM_REMOTE_DIR"
tar "${tar_excludes[@]}" -czf - -C "$REPO_ROOT" . \
  | gcloud_vm "mkdir -p ~/$VM_REMOTE_DIR && tar -xzf - -C ~/$VM_REMOTE_DIR" \
  || die "transfer failed - VM may hold a partial copy, re-run before restarting the poller"

if $do_install; then
  # npm ci would be correct but wipes node_modules and re-downloads Chromium's
  # peer deps on a 1-vCPU e2-micro, which is slow enough to matter. npm install
  # is close enough for a lockfile that only changes when dependencies do.
  say "running npm install on VM"
  gcloud_vm "cd ~/$VM_REMOTE_DIR && npm install --no-audit --no-fund" \
    || die "npm install failed on the VM - fix before restarting the poller"
fi

say "sync complete"
cat <<EOF

The VM is still running the OLD code - this script does not restart it.
To pick up these changes:

  gcloud compute ssh $VM_INSTANCE --zone $VM_ZONE --project $VM_PROJECT
  tmux attach -t poll        # Ctrl+C to stop the poller
  npm run poll:watch         # start it again, then Ctrl+B then D to detach

Check it took effect:

  gcloud compute ssh $VM_INSTANCE --zone $VM_ZONE --project $VM_PROJECT --command "tail -20 ~/$VM_REMOTE_DIR/logs/\\\$(date +%F).log"
EOF
