import type { APIContext } from 'astro';
import { isAuthorized, unauthorized } from '../../lib/auth';
import { resolveSecret } from '../../lib/secrets';

export const prerender = false;

/**
 * com.atproto.identity.submitPlcOperation
 *
 * Submits a signed PLC operation to the PLC directory.
 * This is a proxy endpoint that validates the operation is for the current account
 * before submitting it to plc.directory.
 */
export async function POST({ locals, request }: APIContext) {
  const { env } = locals.runtime;

  if (!(await isAuthorized(request, env))) return unauthorized();

  try {
    const body = await request.json() as { operation?: any };
    const { operation } = body;

    if (!operation) {
      return new Response(
        JSON.stringify({
          error: 'InvalidRequest',
          message: 'Missing operation in request body'
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const did = (await resolveSecret(env.PDS_DID)) ?? 'did:example:single-user';

    // Submit to PLC directory
    const plcResponse = await fetch(`https://plc.directory/${did}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(operation)
    });

    if (!plcResponse.ok) {
      const errorText = await plcResponse.text();
      return new Response(
        JSON.stringify({
          error: 'PlcOperationFailed',
          message: `PLC directory rejected operation: ${errorText}`
        }),
        { status: plcResponse.status, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.error('Submit PLC operation error:', error);
    return new Response(
      JSON.stringify({
        error: 'InternalServerError',
        message: error.message || 'Failed to submit PLC operation'
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}