export function createApp() {
  return {
    // Lazy-import the worker to avoid hard dependency on Astro internals during tests
    fetch: async (req: Request, env: any, ctx: ExecutionContext) => {
      const worker = await import('./_worker');
      return (worker as any).default.fetch(req, env, ctx);
    },
  } as const;
}

