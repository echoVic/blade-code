const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json();

const externals = [
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.optionalDependencies ?? {}),
  ...Object.keys(packageJson.peerDependencies ?? {})
];

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
