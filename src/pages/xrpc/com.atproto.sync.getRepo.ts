import type { APIContext } from 'astro';
import { buildRepoCar } from '../../services/car';

export const prerender = false;

export async function GET({ locals, request }: APIContext) {
  const { env } = locals.runtime;
  const url = new URL(request.url);
  const did = url.searchParams.get('did') ?? (env.PDS_DID ?? 'did:example:single-user');
  const car = await buildRepoCar(env, did);
  return new Response(car.bytes as any, {
    headers: {
      'content-type': 'application/vnd.ipld.car; version=1',
      'content-disposition': 'inline; filename="repo.car"',
    },
  });
}
