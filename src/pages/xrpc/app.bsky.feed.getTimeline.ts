import type { APIContext } from 'astro';
import { proxyAppView } from '../../lib/appview';
import { buildFeedViewPosts, listPosts } from '../../lib/feed';
import { isAuthorized, unauthorized } from '../../lib/auth';

export const prerender = false;

export async function GET({ locals, request }: APIContext) {
  const { env } = locals.runtime;
  if (!(await isAuthorized(request, env))) return unauthorized();

  return proxyAppView({
    request,
    env,
    lxm: 'app.bsky.feed.getTimeline',
    fallback: async () => {
      const url = new URL(request.url);
      const cursor = url.searchParams.get('cursor') ?? undefined;
      const limitParam = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
      const limitInput = Number.isFinite(limitParam) ? limitParam : 50;
      const limit = Math.max(1, Math.min(limitInput, 100));

      const posts = await listPosts(env, limit, cursor);
      const feed = await buildFeedViewPosts(env, posts);
      const nextCursor = posts.length === limit ? String(posts[posts.length - 1].rowid) : undefined;

      const payload: Record<string, unknown> = { feed };
      if (nextCursor) payload.cursor = nextCursor;

      return new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
}
