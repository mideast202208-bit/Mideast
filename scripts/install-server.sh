#!/usr/bin/env bash
# Run on the server you control. This script does not purchase hosting or change DNS.
set -euo pipefail
umask 077
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_dir"
check_dependencies() {
  local missing=0
  if ! command -v docker >/dev/null 2>&1; then echo 'Missing Docker Engine.'; missing=1; fi
  if ! command -v python3 >/dev/null 2>&1; then echo 'Missing Python 3.'; missing=1; fi
  if command -v docker >/dev/null 2>&1 && ! docker compose version >/dev/null 2>&1; then echo 'Missing Docker Compose plugin.'; missing=1; fi
  return "$missing"
}
if [[ "${1:-}" == '--check' ]]; then
  check_dependencies
  echo 'Required commands found. This check did not create services or verify hosting/DNS.'
  exit 0
fi
if [[ "${1:-}" == '--help' || $# -ne 2 ]]; then
  echo 'Usage: bash scripts/install-server.sh CRM_DOMAIN CERTIFICATE_EMAIL'
  echo 'Example domain: crm.your-company.example (without https://)'
  echo 'Check only: bash scripts/install-server.sh --check'
  exit 0
fi
check_dependencies || { echo 'Install the missing prerequisites from their official source, then rerun.'; exit 1; }
if [[ ! -f deploy/.env ]]; then
  python3 - "$1" "$2" <<'PY'
import os,re,secrets,sys
domain,email=sys.argv[1:]
if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9.-]{2,250}',domain) or '.' not in domain:
 raise SystemExit('Invalid domain; use a hostname without protocol or path.')
if not re.fullmatch(r'[A-Za-z0-9._+@-]+',email) or '@' not in email:
 raise SystemExit('Invalid certificate contact email.')
values={'PUBLIC_ORIGIN':'https://'+domain,'CRM_DOMAIN':domain,'ACME_EMAIL':email,
 'BOOTSTRAP_TOKEN':secrets.token_hex(32),'BACKUP_INTERVAL_HOURS':'24','BACKUP_DIR':'/app/backups'}
fd=os.open('deploy/.env',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as f:f.write(''.join(f'{key}={value}\n' for key,value in values.items()))
print('Created protected server settings. Secret values were not printed.')
PY
else
  echo 'Existing deploy/.env retained; supplied domain/email did not replace it.'
fi
docker compose -f deploy/compose.yaml config --quiet
docker compose -f deploy/compose.yaml up -d --build
echo 'Services requested. Verify their health and HTTPS before allowing real customers.'
echo 'Complete owner setup in your browser using BOOTSTRAP_TOKEN from the protected server settings.'
echo 'No Meta account was connected by this installer. Configure it in your application after sign-in.'
