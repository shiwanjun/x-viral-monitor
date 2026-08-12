#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// waffo-bootstrap.mjs — create the monthly and annual Waffo membership products and
// write the PROD_xxx IDs back into the env file.
//
// Replaces the manual "Waffo Dashboard → Subscription Products" step
// described in worker/DEPLOY.md. Uses the official @waffo/pancake-ts SDK
// (RSA-SHA256 signing, same as the Worker's waffo-sign.ts).
//
// Scope (this script): build the two billing intervals for one membership tier.
//   - Webhook URL registration is NOT done here (separate step).
//   - The webhook public key is platform-level and already embedded in the
//     SDK; this script verifies the env value matches but never overwrites.
//
// Idempotent: queries existing subscription products via GraphQL first and
// reuses any tier that already exists with matching name + price.
//
// Usage (from worker/):
//   npm run bootstrap:waffo                      # dry-run (default)
//   WAFFO_DRY_RUN= npm run bootstrap:waffo       # actually create + write back
//
// Env:
//   WAFFO_ENV_FILE   path to the env file to read/write (default: ../.env.test)
//   WAFFO_DRY_RUN    "1"/unset = dry-run (no API writes, no file changes);
//                    ""/"0"     = execute for real.
// ─────────────────────────────────────────────────────────────────────

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WaffoPancake,
  BillingPeriod,
  TaxCategory,
  ProductVersionStatus,
  // @ts-ignore — no type declarations needed at runtime for a .mjs script
} from "@waffo/pancake-ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = path.resolve(__dirname, "..");

// ─── Tier definitions ────────────────────────────────────────────────
// $57.50 is $5.99 × 12 × 80%, rounded to the nearest USD cent.
const TIERS = [
  {
    interval: "monthly",
    varName: "WAFFO_PRODUCT_MEMBERSHIP_MONTHLY",
    name: "X-Tools Membership (Monthly)",
    amount: "5.99",
    billingPeriod: BillingPeriod.Monthly,
    description: "Full X-Tools membership. Cancel anytime.",
  },
  {
    interval: "yearly",
    varName: "WAFFO_PRODUCT_MEMBERSHIP_YEARLY",
    name: "X-Tools Membership (Annual)",
    amount: "57.50",
    billingPeriod: BillingPeriod.Yearly,
    description: "Full X-Tools membership. Annual billing saves 20%.",
  },
];

const USD = "USD";
const RETIRED_PRODUCT_NAMES = new Set([
  "X-Tools Standard",
  "X-Tools Pro",
  "X-Tools Max",
]);

// ─── .env parser (no new deps) ───────────────────────────────────────
// Handles quoted values, keeps literal \n sequences intact (the SDK's
// normalizePrivateKey converts them to real newlines).
function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // strip matching surrounding quotes, keep inner content verbatim
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** Re-encode a value for writing back to a .env line (quote if it has #/spaces/newlines). */
function encodeEnvValue(val) {
  if (/[\s#"']/.test(val)) {
    return `"${val.replace(/"/g, '\\"')}"`;
  }
  return val;
}

/**
 * Replace membership product IDs and migrate the former three-tier variable
 * names in-place.  Secrets are never parsed or rewritten outside these lines.
 */
function patchProductIds(envText, updates) {
  let remaining = { ...updates };
  const lines = envText.split(/\r?\n/);
  const out = lines.map((line) => {
    const trimmed = line.trim();
    const legacyVar = trimmed.startsWith("WAFFO_PRODUCT_STANDARD=")
      ? "WAFFO_PRODUCT_STANDARD"
      : trimmed.startsWith("WAFFO_PRODUCT_PRO=")
        ? "WAFFO_PRODUCT_PRO"
        : trimmed.startsWith("WAFFO_PRODUCT_MAX=")
          ? "WAFFO_PRODUCT_MAX"
          : null;
    if (legacyVar) {
      const replacement = legacyVar === "WAFFO_PRODUCT_PRO"
        ? "WAFFO_PRODUCT_MEMBERSHIP_MONTHLY"
        : legacyVar === "WAFFO_PRODUCT_MAX"
          ? "WAFFO_PRODUCT_MEMBERSHIP_YEARLY"
          : null;
      if (!replacement) return "";
      const value = remaining[replacement];
      if (value) {
        delete remaining[replacement];
        return `${replacement}=${encodeEnvValue(value)}`;
      }
      return "";
    }
    for (const [varName, value] of Object.entries(remaining)) {
      if (trimmed.startsWith(`${varName}=`)) {
        delete remaining[varName];
        return `${varName}=${encodeEnvValue(value)}`;
      }
    }
    return line;
  });
  for (const [varName, value] of Object.entries(remaining)) {
    out.push(`${varName}=${encodeEnvValue(value)}`);
  }
  return { newText: out.join("\n"), missing: [] };
}

// ─── main ────────────────────────────────────────────────────────────
async function main() {
  const envPath = path.resolve(
    WORKER_DIR,
    process.env.WAFFO_ENV_FILE || "../.env.test",
  );
  const dryRun = process.env.WAFFO_DRY_RUN !== "" && process.env.WAFFO_DRY_RUN !== "0";

  if (!existsSync(envPath)) {
    fail(`env file not found: ${envPath}`);
  }
  const envText = await readFile(envPath, "utf8");
  const env = parseEnv(envText);

  const merchantId = env.WAFFO_MERCHANT_ID;
  const storeId = env.WAFFO_STORE_ID;
  const privateKey = env.WAFFO_PRIVATE_KEY;
  const waffoEnv = env.WAFFO_ENV || "test";

  if (!merchantId || !/^[A-Za-z]+_/.test(merchantId)) {
    fail(`WAFFO_MERCHANT_ID missing or invalid in ${envPath} (got: ${mask(merchantId)})`);
  }
  if (!storeId || !/^[A-Za-z]+_/.test(storeId)) {
    fail(`WAFFO_STORE_ID missing or invalid in ${envPath} (got: ${mask(storeId)})`);
  }
  if (!privateKey || !privateKey.includes("PRIVATE KEY")) {
    fail(`WAFFO_PRIVATE_KEY missing or not a PEM in ${envPath}`);
  }

  console.log(`env file : ${envPath}`);
  console.log(`merchant : ${merchantId}`);
  console.log(`store    : ${storeId}`);
  console.log(`env      : ${waffoEnv}`);
  console.log(`mode     : ${dryRun ? "DRY-RUN (no writes)" : "EXECUTE (real writes)"}`);
  console.log("");

  const client = new WaffoPancake({
    merchantId,
    privateKey,
    environment: waffoEnv,
  });

  // ── 1. List existing subscription products (idempotency) ──────────
  // Schema notes (verified via introspection on 2026-08-11):
  //   - the `id` variable is a `String!`, NOT the `ID` scalar
  //   - `prices` is `[CurrencyPrice!]!`, each with `{ currency, priceInfo { amount } }`
  let existing = [];
  try {
    const res = await client.graphql.query({
      query: `query ($id: String!) {
        store(id: $id) {
          id
          subscriptionProducts {
            id
            name
            billingPeriod
            status
            prices { currency priceInfo { amount } }
          }
        }
      }`,
      variables: { id: storeId },
    });
    // graphql.query does NOT throw on partial failures — check errors.
    if (res.errors?.length) {
      const msg = res.errors.map((e) => e.message).join("; ");
      fail(`GraphQL query for existing products failed: ${msg}`);
    }
    existing = res.data?.store?.subscriptionProducts || [];
  } catch (e) {
    fail(`GraphQL query for existing products failed: ${e?.message || e}`);
  }

  console.log(`found ${existing.length} existing subscription product(s) in store.`);
  if (existing.length) {
    for (const p of existing) {
      const usd = parseUsdAmount(p.prices);
      console.log(`  - ${p.id}  "${p.name}"  ${p.billingPeriod}  ${usd ? "$" + usd : "(no USD price)"}  [${p.status}]`);
    }
  }
  console.log("");

  // ── 2. Resolve each tier (reuse / publish / create) ───────────────
  const results = {}; // varName -> { action, id, name }
  for (const tier of TIERS) {
    const match = existing.find(
      (p) => p.name === tier.name
        && p.billingPeriod === tier.billingPeriod
        && parseUsdAmount(p.prices) === tier.amount,
    );

    if (match && match.status === ProductVersionStatus.Active) {
      results[tier.varName] = { action: "REUSE", id: match.id, name: tier.name };
      continue;
    }

    if (match && match.status !== ProductVersionStatus.Active) {
      // exists but not published/active
      if (dryRun) {
        results[tier.varName] = { action: "PUBLISH (dry-run)", id: match.id, name: tier.name };
        continue;
      }
      try {
        const { product } = await client.subscriptionProducts.publish({ id: match.id });
        results[tier.varName] = { action: "PUBLISHED", id: product.id, name: product.name };
      } catch (e) {
        fail(`publish failed for ${tier.name} (${match.id}): ${e?.message || e}`);
      }
      continue;
    }

    // name/price mismatch or missing entirely → create
    if (dryRun) {
      results[tier.varName] = { action: "CREATE (dry-run)", id: "(would create)", name: tier.name };
      continue;
    }
    try {
      const { product: created } = await client.subscriptionProducts.create({
        storeId,
        name: tier.name,
        billingPeriod: tier.billingPeriod,
        prices: { [USD]: { amount: tier.amount, taxCategory: TaxCategory.SaaS } },
        description: tier.description,
      });
      const { product: published } = await client.subscriptionProducts.publish({ id: created.id });
      results[tier.varName] = { action: "CREATED", id: published.id, name: published.name };
    } catch (e) {
      fail(`create failed for ${tier.name}: ${e?.message || e}`);
    }
  }

  // The former three tiers must not remain purchasable once the membership
  // products are live.  Marking a product inactive only removes it from new
  // checkout; existing subscribers are preserved by the Worker migration.
  const retired = existing.filter((p) =>
    RETIRED_PRODUCT_NAMES.has(p.name) && p.status === ProductVersionStatus.Active,
  );
  const retiredResults = [];
  for (const product of retired) {
    if (dryRun) {
      retiredResults.push({ action: "DEACTIVATE (dry-run)", id: product.id, name: product.name });
      continue;
    }
    try {
      const { product: updated } = await client.subscriptionProducts.updateStatus({
        id: product.id,
        status: ProductVersionStatus.Inactive,
      });
      retiredResults.push({ action: "DEACTIVATED", id: updated.id, name: updated.name });
    } catch (e) {
      fail(`could not deactivate retired product ${product.name} (${product.id}): ${e?.message || e}`);
    }
  }

  // ── 3. Report ─────────────────────────────────────────────────────
  console.log("─── results ───");
  for (const tier of TIERS) {
    const r = results[tier.varName];
    console.log(`  ${r.action.padEnd(18)} ${r.id.padEnd(28)} ${tier.name}  ($${tier.amount}/${tier.interval})`);
  }
  for (const r of retiredResults) {
    console.log(`  ${r.action.padEnd(18)} ${r.id.padEnd(28)} ${r.name}`);
  }
  console.log("");

  if (dryRun) {
    console.log("dry-run: no API writes performed, env file unchanged.");
    console.log("To execute for real, re-run with:  WAFFO_DRY_RUN= npm run bootstrap:waffo");
    return;
  }

  // ── 4. Write PROD_xxx back into the env file ──────────────────────
  const updates = {};
  for (const tier of TIERS) {
    const r = results[tier.varName];
    if (r?.id && /^PROD_/.test(r.id)) {
      updates[tier.varName] = r.id;
    }
  }

  const { newText, missing } = patchProductIds(envText, updates);
  if (missing.length) fail(`could not patch env var line(s): ${missing.join(", ")}`);

  await writeFile(envPath, newText, "utf8");
  console.log(`updated ${envPath}:`);
  for (const [k, v] of Object.entries(updates)) {
    console.log(`  ${k}=${v}`);
  }
  console.log("");
  console.log("Next: set these as Worker secrets, e.g.");
  console.log("  cd worker");
  for (const tier of TIERS) {
    const r = results[tier.varName];
    if (r?.id) {
      console.log(`  npx wrangler secret put ${tier.varName} -c wrangler.auth.toml   # value: ${r.id}`);
    }
  }
}

// ─── helpers ─────────────────────────────────────────────────────────

/**
 * Extract the USD amount string from a product's `prices` field.
 * Handles two shapes:
 *   - GraphQL: `prices: [{ currency: "USD", priceInfo: { amount: "3.99" } }]`
 *   - REST/SDK: `prices: { USD: { amount: "3.99" } }`
 * `prices` may be a parsed value or a JSON string.
 */
function parseUsdAmount(prices) {
  if (!prices) return null;
  let obj = prices;
  if (typeof prices === "string") {
    try {
      obj = JSON.parse(prices);
    } catch {
      return null;
    }
  }
  // GraphQL array shape
  if (Array.isArray(obj)) {
    const usd = obj.find((p) => p?.currency === USD);
    return usd?.priceInfo?.amount ?? null;
  }
  // REST object-key shape
  const entry = obj?.[USD];
  if (!entry) return null;
  return typeof entry === "string" ? entry : entry.amount ?? null;
}

function mask(s) {
  if (!s) return "(empty)";
  if (s.length <= 8) return s[0] + "***";
  return `${s.slice(0, 5)}…${s.slice(-3)}`;
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

main().catch((e) => fail(e?.stack || e?.message || String(e)));
