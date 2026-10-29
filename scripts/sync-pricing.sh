#!/bin/sh
# Copy the shared pricing engine to the browser. Run after editing supabase/functions/_shared/pricing.mjs.
set -e
cd "$(dirname "$0")/.."
cp supabase/functions/_shared/pricing.mjs public/assets/pricing.mjs
echo "pricing.mjs synced"
