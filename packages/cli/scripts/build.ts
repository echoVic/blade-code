import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json();

const externals = [
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.optionalDependencies ?? {}),
  ...Object.keys(packageJson.peerDependencies ?? {})
];

console.log("Building backend...");

const result = await Bun.build({
  entrypoints: ["src/blade.tsx"],
  outdir: "dist",
  target: "node",
  minify: true,
  external: externals
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log.message);
  }
  process.exit(1);
}

console.log("✓ Backend built successfully\n");

const webDir = join(rootDir, "web");
if (existsSync(join(webDir, "vite.config.ts"))) {
  console.log("Building web UI...");

  const buildWeb = (): Promise<void> => {
    return new Promise((resolve, reject) => {
      const child = spawn("npx", ["vite", "build"], {
        cwd: webDir,
        stdio: "inherit",
        shell: true,
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Web build failed with exit code ${code}`));
        }
      });

      child.on("error", (err) => {
        reject(err);
      });
    });
  };

  try {
    await buildWeb();
    console.log("✓ Web UI built successfully\n");
  } catch (error) {
    console.error("Failed to build web UI:", error);
    process.exit(1);
  }
} else {
  console.log("Web UI source not found, skipping web build.\n");
}

console.log("✓ Build completed!");
