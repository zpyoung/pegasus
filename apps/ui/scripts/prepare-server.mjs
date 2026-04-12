#!/usr/bin/env node

/**
 * This script prepares the server for bundling with Electron.
 * It copies the server dist and installs production dependencies
 * in a way that works with pnpm workspaces.
 */

import { execSync } from "child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  lstatSync,
} from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const APP_DIR = join(__dirname, "..");
const SERVER_DIR = join(APP_DIR, "..", "server");
const LIBS_DIR = join(APP_DIR, "..", "..", "libs");
const BUNDLE_DIR = join(APP_DIR, "server-bundle");

// Local workspace packages that need to be bundled
const LOCAL_PACKAGES = [
  "@pegasus/types",
  "@pegasus/utils",
  "@pegasus/prompts",
  "@pegasus/platform",
  "@pegasus/model-resolver",
  "@pegasus/dependency-resolver",
  "@pegasus/git-utils",
];

console.log("🔧 Preparing server for Electron bundling...\n");

// Step 1: Clean up previous bundle
if (existsSync(BUNDLE_DIR)) {
  console.log("🗑️  Cleaning previous server-bundle...");
  rmSync(BUNDLE_DIR, { recursive: true });
}
mkdirSync(BUNDLE_DIR, { recursive: true });

// Step 2: Build the server TypeScript
console.log("📦 Building server TypeScript...");
execSync("pnpm build", { cwd: SERVER_DIR, stdio: "inherit" });

// Step 3: Copy server dist
console.log("📋 Copying server dist...");
cpSync(join(SERVER_DIR, "dist"), join(BUNDLE_DIR, "dist"), { recursive: true });

// Step 4: Copy local workspace packages
console.log("📦 Copying local workspace packages...");
const bundleLibsDir = join(BUNDLE_DIR, "libs");
mkdirSync(bundleLibsDir, { recursive: true });

for (const pkgName of LOCAL_PACKAGES) {
  const pkgDir = pkgName.replace("@pegasus/", "");
  const srcDir = join(LIBS_DIR, pkgDir);
  const destDir = join(bundleLibsDir, pkgDir);

  if (!existsSync(srcDir)) {
    console.warn(`⚠️  Warning: Package ${pkgName} not found at ${srcDir}`);
    continue;
  }

  mkdirSync(destDir, { recursive: true });

  // Copy dist folder
  if (existsSync(join(srcDir, "dist"))) {
    cpSync(join(srcDir, "dist"), join(destDir, "dist"), { recursive: true });
  }

  // Copy + rewrite package.json: replace workspace:* with file: refs to
  // sibling lib dirs, and drop devDependencies (not needed at runtime).
  if (existsSync(join(srcDir, "package.json"))) {
    const libPkg = JSON.parse(
      readFileSync(join(srcDir, "package.json"), "utf-8"),
    );
    if (libPkg.dependencies) {
      for (const depName of Object.keys(libPkg.dependencies)) {
        if (LOCAL_PACKAGES.includes(depName)) {
          const depDir = depName.replace("@pegasus/", "");
          libPkg.dependencies[depName] = `file:../${depDir}`;
        }
      }
    }
    delete libPkg.devDependencies;
    delete libPkg.scripts;
    writeFileSync(
      join(destDir, "package.json"),
      JSON.stringify(libPkg, null, 2),
    );
  }

  console.log(`   ✓ ${pkgName}`);
}

// Step 5: Create a minimal package.json for the server
console.log("📝 Creating server package.json...");
const serverPkg = JSON.parse(
  readFileSync(join(SERVER_DIR, "package.json"), "utf-8"),
);

// Replace local package versions with file: references
const dependencies = { ...serverPkg.dependencies };
for (const pkgName of LOCAL_PACKAGES) {
  if (dependencies[pkgName]) {
    const pkgDir = pkgName.replace("@pegasus/", "");
    dependencies[pkgName] = `file:libs/${pkgDir}`;
  }
}

const bundlePkg = {
  name: "@pegasus/server-bundle",
  version: serverPkg.version,
  type: "module",
  main: "dist/index.js",
  dependencies,
};

writeFileSync(
  join(BUNDLE_DIR, "package.json"),
  JSON.stringify(bundlePkg, null, 2),
);

// Step 6: Install production dependencies
// --ignore-workspace prevents pnpm from climbing up to the parent workspace
// (server-bundle sits under apps/ui/, so pnpm would otherwise install into the
// workspace root instead of server-bundle/node_modules).
// --config.node-linker=hoisted produces a flat node_modules tree that works
// correctly when copied by electron-builder and for runtime resolution.
console.log("📥 Installing server production dependencies...");
execSync(
  "pnpm install --prod --ignore-workspace --config.node-linker=hoisted",
  {
    cwd: BUNDLE_DIR,
    stdio: "inherit",
  },
);

// Step 6b: Replace symlinks for local packages with real copies
// pnpm install creates symlinks for file: references, but these break when packaged by electron-builder
console.log("🔗 Replacing symlinks with real directory copies...");
const nodeModulesPegasus = join(BUNDLE_DIR, "node_modules", "@pegasus");
for (const pkgName of LOCAL_PACKAGES) {
  const pkgDir = pkgName.replace("@pegasus/", "");
  const nmPkgPath = join(nodeModulesPegasus, pkgDir);
  try {
    // lstatSync does not follow symlinks, allowing us to check for broken ones
    if (lstatSync(nmPkgPath).isSymbolicLink()) {
      const realPath = resolve(BUNDLE_DIR, "libs", pkgDir);
      rmSync(nmPkgPath);
      cpSync(realPath, nmPkgPath, { recursive: true });
      console.log(`   ✓ Replaced symlink: ${pkgName}`);
    }
  } catch (error) {
    // If the path doesn't exist, lstatSync throws ENOENT. We can safely ignore this.
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

// Step 7: Rebuild native modules for current architecture
// This is critical for modules like node-pty that have native bindings
console.log("🔨 Rebuilding native modules for current architecture...");
try {
  execSync("pnpm rebuild", {
    cwd: BUNDLE_DIR,
    stdio: "inherit",
  });
  console.log("✅ Native modules rebuilt successfully");
} catch (error) {
  console.warn(
    "⚠️  Warning: Failed to rebuild native modules. Terminal functionality may not work.",
  );
  console.warn("   Error:", error.message);
}

console.log("\n✅ Server prepared for bundling at:", BUNDLE_DIR);
