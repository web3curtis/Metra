#!/usr/bin/env bash
# Reproducible candidate digest for the WebMCP reliability prototype.
#
# Usage: tools/freeze-candidate.sh [version]
# Hashes every executable source file that a Codex evaluation can reach, in a
# stable order, so the same tree always yields the same digest on any machine.
set -euo pipefail

VERSION="${1:-unversioned}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FILES=$(find prototypes/webmcp-test-app/src prototypes/webmcp-test-app/tests \
             prototypes/reliability-boundary adapters skills .codex-plugin \
        -type f \( -name '*.ts' -o -name '*.json' -o -name '*.md' \) \
        -not -path '*/node_modules/*' | LC_ALL=C sort)

DIGEST=$(printf '%s\n' "$FILES" | while read -r file; do
  printf '%s  %s\n' "$(shasum -a 256 "$file" | cut -d' ' -f1)" "$file"
done | shasum -a 256 | cut -d' ' -f1)

COUNT=$(printf '%s\n' "$FILES" | wc -l | tr -d ' ')

printf '%s\n' "{"
printf '  "candidate_version": "%s",\n' "$VERSION"
printf '  "content_digest": "sha256:%s",\n' "$DIGEST"
printf '  "file_count": %s,\n' "$COUNT"
printf '  "reproduce_with": "tools/freeze-candidate.sh %s"\n' "$VERSION"
printf '%s\n' "}"
