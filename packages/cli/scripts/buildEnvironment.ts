export function createWebBuildEnvironment(
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  return {
    ...environment,
    NODE_ENV: 'production',
  };
}
