// Builds one self-contained file per Edge Function into supabase/dashboard/<name>/index.ts,
// for pasting into the Supabase dashboard editor (no CLI needed).
// Usage: npm i -D esbuild && node scripts/bundle-functions.mjs
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
for (const fn of ["public", "portal", "admin", "stripe-webhook", "daily"]) {
  const out = `supabase/dashboard/${fn}/index.ts`;
  await build({ entryPoints: [`supabase/functions/${fn}/index.ts`], outfile: out, bundle: true, format: "esm", platform: "neutral", target: "es2022", external: ["npm:*"], legalComments: "none", charset: "utf8" });
  const body = readFileSync(out, "utf8").replace(/^\/\/ (\.\.\/)*supabase\/functions\//gm, "// ");
  writeFileSync(out, `// @ts-nocheck\n// MowBrokers Edge Function "${fn}" — single-file build of supabase/functions/${fn} + _shared for the Supabase dashboard editor.\n// Source of truth is supabase/functions; regenerate with scripts/bundle-functions.mjs.\n\n${body}`);
}
console.log("bundled into supabase/dashboard/");
