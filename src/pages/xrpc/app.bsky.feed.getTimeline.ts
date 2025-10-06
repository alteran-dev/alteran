import type { APIContext } from 'astro';
import { proxyAppView } from '../../lib/appview';
import { buildFeedViewPosts, listPosts } from '../../lib/feed';
import { isAuthorized, unauthorized } from '../../lib/auth';

export const prerender = false;

export async function GET({ locals, request }: APIContext) {
  const { env } = locals.runtime;
  if (!(await isAuthorized(request, env))) return unauthorized();

  try {
    return await proxyAppView({
      request,
      env,
      lxm: 'app.bsky.feed.getTimeline',
      fallback: async () => {
        console.log('app.bsky.feed.getTimeline: Using fallback');
        const url = new URL(request.url);
        const cursor = url.searchParams.get('cursor') ?? undefined;
        const limitParam = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
        const limitInput = Number.isFinite(limitParam) ? limitParam : 50;
        const limit = Math.max(1, Math.min(limitInput, 100));

        console.log('app.bsky.feed.getTimeline: fetching posts', { limit, cursor });
        const posts = await listPosts(env, limit, cursor);
        console.log('app.bsky.feed.getTimeline: found posts', posts.length);
        const feed = await buildFeedViewPosts(env, posts);
        const nextCursor = posts.length === limit ? String(posts[posts.length - 1].rowid) : undefined;

        const payload: Record<string, unknown> = { feed };
        if (nextCursor) payload.cursor = nextCursor;

        console.log('app.bsky.feed.getTimeline: returning feed', { feedLength: feed.length, nextCursor });
        return new Response(JSON.stringify(payload), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
  } catch (error) {
    console.error('app.bsky.feed.getTimeline error:', error);
    return new Response(JSON.stringify({ error: 'InternalServerError', message: String(error) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
