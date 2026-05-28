#!/usr/bin/env bash
set -euo pipefail

# ── guard: must run from the QQ plugin root ──────────────────────────
REQUIRED_NAME="@openclaw/qq"
ACTUAL_NAME=$(node -e "try{process.stdout.write(require('./package.json').name||'')}catch(e){}" 2>/dev/null || true)

if [ "$ACTUAL_NAME" != "$REQUIRED_NAME" ]; then
  echo "ERROR: this script must be run from the QQ plugin directory (~/.openclaw/extensions/qq)"
  echo "  expected package name: $REQUIRED_NAME"
  echo "  actual   package name: ${ACTUAL_NAME:-<not found>}"
  exit 1
fi

echo "[1/6] Installing npm dependencies..."
npm install

# ── tsconfig.json ────────────────────────────────────────────────────
echo "[2/6] Ensuring tsconfig.json..."
if [ ! -f tsconfig.json ]; then
  cat > tsconfig.json <<'TSCONFIG'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "strict": false,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["index.ts", "src/**/*.ts"]
}
TSCONFIG
  echo "  tsconfig.json created."
else
  echo "  tsconfig.json already exists, skipping."
fi

# ── patch SDK imports (4.x → 5.x compat) ────────────────────────────
echo "[3/6] Patching SDK imports for openclaw 5.x..."

CHANNEL_TS="src/channel.ts"

# Only patch if not already done
if grep -q 'openclaw/plugin-sdk/channel-config-schema' "$CHANNEL_TS" 2>/dev/null; then
  echo "  SDK imports already patched, skipping."
else
  python3 - "$CHANNEL_TS" <<'PYEOF'
import sys
p = sys.argv[1]

with open(p) as f:
    content = f.read()

old = """import {
    type ChannelPlugin,
    type ChannelAccountSnapshot,
    type ChannelSetupInput,
    type OpenClawConfig,
    buildChannelConfigSchema,
    type ReplyPayload,
    applyAccountNameToChannelSection,
    migrateBaseNameToDefaultAccount,
} from "openclaw/plugin-sdk";"""

new = """import {
    type ChannelPlugin,
    type ChannelAccountSnapshot,
    type ChannelSetupInput,
    type OpenClawConfig,
    type ReplyPayload,
} from "openclaw/plugin-sdk";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { applyAccountNameToChannelSection, migrateBaseNameToDefaultAccount } from "openclaw/plugin-sdk/setup";"""

if old in content:
    content = content.replace(old, new)
    with open(p, 'w') as f:
        f.write(content)
    print("  SDK imports patched successfully.")
elif "openclaw/plugin-sdk/channel-config-schema" in content:
    print("  SDK imports already patched.")
else:
    print("  WARNING: could not find expected import block — the patch may not apply.", file=sys.stderr)
    print("  This plugin may not compile. Please check src/channel.ts manually.", file=sys.stderr)
PYEOF
fi

# ── compile TypeScript ───────────────────────────────────────────────
echo "[4/6] Compiling TypeScript..."
rm -rf dist/
npx tsc
echo "  Compilation successful. Output in dist/"

# ── update package.json entry points ─────────────────────────────────
echo "[5/6] Updating package.json entry points..."

node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
let changed = false;

if (pkg.main !== './dist/index.js') {
  pkg.main = './dist/index.js';
  changed = true;
}

const ext = (pkg.openclaw && pkg.openclaw.extensions) || [];
if (ext.length !== 1 || ext[0] !== './dist/index.js') {
  pkg.openclaw = pkg.openclaw || {};
  pkg.openclaw.extensions = ['./dist/index.js'];
  changed = true;
}

if (changed) {
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  console.log('  package.json updated.');
} else {
  console.log('  package.json already correct, skipping.');
}
"

# ── install plugin ───────────────────────────────────────────────────
echo "[6/6] Installing plugin with openclaw..."
openclaw plugins install . --dangerously-force-unsafe-install --force

# ── restart gateway ──────────────────────────────────────────────────
echo ""
echo "Restarting gateway..."
openclaw gateway restart

echo ""
echo "Done! QQ plugin installed and gateway restarted."
echo "Run 'openclaw plugins list | grep qq' to verify."
