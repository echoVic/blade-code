import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
if (existsSync(join(webDir, "package.json"))) {
  console.log("Building web UI...");

  const runPnpm = (
    args: string[],
    label: string,
    registry?: string
  ): Promise<void> => {
    return new Promise((resolve, reject) => {
      const child = spawn("pnpm", args, {
        cwd: webDir,
        stdio: "inherit",
        shell: true,
        env: registry
          ? {
              ...process.env,
              PNPM_CONFIG_REGISTRY: registry,
              NPM_CONFIG_REGISTRY: registry,
              npm_config_registry: registry,
            }
          : process.env,
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Web ${label} failed with exit code ${code}`));
        }
      });

      child.on("error", (err) => {
        reject(err);
      });
    });
  };

  const loadWebRegistry = async (): Promise<string | undefined> => {
    const npmrcPath = join(webDir, ".npmrc");
    if (!existsSync(npmrcPath)) {
      return undefined;
    }
    const npmrc = await readFile(npmrcPath, "utf8");
    const registryLine = npmrc
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("registry="));
    if (!registryLine) {
      return undefined;
    }
    const [, registry] = registryLine.split("=", 2);
    return registry?.trim() || undefined;
  };

  const ensureWebDependencies = async (): Promise<void> => {
    const nodeModulesDir = join(webDir, "node_modules");
    const webPackageJson = await Bun.file(join(webDir, "package.json")).json();
    const requiredDeps = [
      ...Object.keys(webPackageJson.dependencies ?? {}),
      ...Object.keys(webPackageJson.devDependencies ?? {}),
    ];

    const missingDeps = requiredDeps.filter((dep: string) =>
      !existsSync(join(nodeModulesDir, dep))
    );

    if (missingDeps.length === 0) {
      return;
    }

    console.log(`Installing web UI dependencies (${missingDeps.length} missing)...`);
    const registry = await loadWebRegistry();
    const lockFile = join(webDir, "pnpm-lock.yaml");
    const installArgs = existsSync(lockFile)
      ? ["install", "--frozen-lockfile"]
      : ["install"];

    await runPnpm(installArgs, "install", registry);
  };
  
  const buildWeb = (): Promise<void> => {
    return runPnpm(["build"], "build");
  };

  try {
    await ensureWebDependencies();
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
