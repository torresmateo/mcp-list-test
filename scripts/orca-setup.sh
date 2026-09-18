#!/usr/bin/env bash
# Orca repo setup hook — runs once per worktree, before any worker starts.
#
# Wire it up in the Orca app: Repo settings -> hooks -> setup script:
#   bash scripts/orca-setup.sh
# Set the repo's setup policy to wait-for-setup, not start-immediately. An agent
# that begins before install finishes runs the tests against a half-installed
# tree, reads the resulting errors as a broken repo, and starts fixing what is
# not wrong.
#
# Two jobs:
#   1. Give this worktree a port block no other live worktree holds, plus a
#      Compose project name, written to an untracked .env.local.
#   2. Install dependencies, detected from whichever lockfile is present.
#
# Why isolation is the whole point. Several worktrees run side by side. Two of
# them running the same dev stack unnamespaced do not merely fight over ports:
# Docker Compose derives container AND volume names from the project name,
# which defaults to the directory name. Two checkouts of the same repo then
# share one database volume while believing they are isolated. That failure is
# silent and looks like flaky tests. So each worktree gets COMPOSE_PROJECT_NAME
# as well as its own ports, whether or not the project uses Compose today.
#
# Compose does NOT read .env.local. Compose commands in a worktree need:
#   docker compose --env-file .env.local up -d
#
# Claims are host-wide (~/.cache/orca-portblocks) so worktrees of different
# projects cannot collide either.
#
# Idempotent: re-running keeps the block this worktree already holds.
set -euo pipefail

WORKTREE="$(pwd -P)"
PROJECT="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)" | tr -c 'a-zA-Z0-9\n' '-' | tr '[:upper:]' '[:lower:]')"
CLAIMS="${XDG_CACHE_HOME:-$HOME/.cache}/orca-portblocks"
ENVFILE="$WORKTREE/.env.local"
BLOCK=10
BASE_MIN=${ORCA_PORT_MIN:-3400}
BASE_MAX=${ORCA_PORT_MAX:-3990}

mkdir -p "$CLAIMS"

listening() { # is anything bound to this port right now?
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    nc -z 127.0.0.1 "$1" >/dev/null 2>&1
  fi
}

block_free() { # every port in the block unbound by anyone, Orca or not
  local base="$1" i
  for ((i = 0; i < BLOCK; i++)); do
    listening "$((base + i))" && return 1
  done
  return 0
}

claim_owner() { [ -f "$CLAIMS/$1" ] && cat "$CLAIMS/$1" || true; }

# A claim whose worktree directory is gone is stale. Orca removes worktrees on
# `worktree rm`, so this is how blocks return to circulation when the archive
# hook did not get to run.
reap_stale() {
  local owner
  owner="$(claim_owner "$1")"
  if [ -n "$owner" ] && [ ! -d "$owner" ]; then
    rm -f "$CLAIMS/$1"
  fi
}

# Already hold a block? Keep it, so re-running setup is a no-op.
if [ -f "$ENVFILE" ]; then
  existing="$(sed -n 's/^PORT_BASE=\([0-9]\{1,\}\)$/\1/p' "$ENVFILE" | head -1)"
  if [ -n "$existing" ] && [ "$(claim_owner "$existing")" = "$WORKTREE" ]; then
    echo "orca-setup: keeping PORT_BASE=$existing"
    BASE="$existing"
  fi
fi

if [ -z "${BASE:-}" ]; then
  for b in $(seq "$BASE_MIN" "$BLOCK" "$BASE_MAX"); do
    reap_stale "$b"
    [ -e "$CLAIMS/$b" ] && continue
    block_free "$b" || continue
    # noclobber makes this create-or-fail, which is the atomic bit: two workers
    # starting at the same instant cannot both win the same block.
    if (
      set -o noclobber
      printf '%s\n' "$WORKTREE" >"$CLAIMS/$b"
    ) 2>/dev/null; then
      BASE="$b"
      echo "orca-setup: claimed PORT_BASE=$BASE"
      break
    fi
  done
fi

if [ -z "${BASE:-}" ]; then
  echo "orca-setup: no free block in $BASE_MIN-$((BASE_MAX + BLOCK - 1))." >&2
  echo "orca-setup: stale claims live in $CLAIMS — remove any whose worktree is gone." >&2
  exit 1
fi

WEB=$((BASE + 0))
DB=$((BASE + 1))
COMPOSE_PROJECT="$PROJECT-$BASE"

{
  echo "# Written by scripts/orca-setup.sh. Do not edit; setup rewrites it."
  echo "# This worktree owns ports $BASE-$((BASE + BLOCK - 1))."
  echo "#"
  echo "# Compose does not read this file. Use:"
  echo "#   docker compose --env-file .env.local up -d"
  echo "# For tools that do not load .env.local on their own:"
  echo "#   set -a; . ./.env.local; set +a"
  echo "PORT_BASE=$BASE"
  echo "PORT_WEB=$WEB"
  echo "PORT_DB=$DB"
  echo "PORT=$WEB"
  echo
  echo "# Namespaces this worktree's containers AND its volumes. Without it,"
  echo "# two worktrees silently share one database volume."
  echo "COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT"
  echo
  echo "# ---- project-specific derived values ----------------------------------"
  echo "# Add lines below in the PROJECT-SPECIFIC block of scripts/orca-setup.sh,"
  echo "# e.g. DATABASE_URL built from PORT_DB. Keep them derived from the ports"
  echo "# above so every worktree stays isolated."
  # ---- PROJECT-SPECIFIC: add derived variables here ------------------------
  # Example (uncomment and adapt):
  # echo "DATABASE_URL=postgres://app:app@localhost:$DB/app"
  # echo "DATABASE_SSL=disable"
  # --------------------------------------------------------------------------
} >"$ENVFILE"

# ---- Dependency install, detected from the lockfile -------------------------
install() {
  if [ -f bun.lock ] || [ -f bun.lockb ]; then
    command -v bun >/dev/null && { echo "orca-setup: bun install"; bun install --frozen-lockfile; return; }
  fi
  if [ -f pnpm-lock.yaml ]; then
    command -v pnpm >/dev/null && { echo "orca-setup: pnpm install"; pnpm install --frozen-lockfile; return; }
  fi
  if [ -f yarn.lock ]; then
    command -v yarn >/dev/null && { echo "orca-setup: yarn install"; yarn install --frozen-lockfile; return; }
  fi
  if [ -f package-lock.json ]; then
    command -v npm >/dev/null && { echo "orca-setup: npm ci"; npm ci; return; }
  fi
  if [ -f uv.lock ]; then
    command -v uv >/dev/null && { echo "orca-setup: uv sync"; uv sync --frozen; return; }
  fi
  if [ -f poetry.lock ]; then
    command -v poetry >/dev/null && { echo "orca-setup: poetry install"; poetry install; return; }
  fi
  if [ -f requirements.txt ] && command -v uv >/dev/null; then
    echo "orca-setup: uv venv + pip install -r requirements.txt"
    uv venv --quiet && uv pip install -r requirements.txt
    return
  fi
  if [ -f go.mod ]; then
    command -v go >/dev/null && { echo "orca-setup: go mod download"; go mod download; return; }
  fi
  if [ -f Cargo.toml ]; then
    command -v cargo >/dev/null && { echo "orca-setup: cargo fetch"; cargo fetch; return; }
  fi
  echo "orca-setup: no recognised lockfile; skipping install (edit install() in scripts/orca-setup.sh)"
}
install

echo "orca-setup: ready — ports $BASE-$((BASE + BLOCK - 1)) (web $WEB, db $DB), project $COMPOSE_PROJECT"
