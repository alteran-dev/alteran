import type { APIContext } from 'astro';
import { Secp256k1Keypair } from '@atproto/crypto';
import { isAuthorized, unauthorized } from '../../lib/auth';
import { resolveSecret } from '../../lib/secrets';
import * as uint8arrays from 'uint8arrays';

export const prerender = false;

interface PlcOperation {
  type: string;
  rotationKeys: string[];
  verificationMethods?: Record<string, string>;
  alsoKnownAs?: string[];
  services?: Record<string, { type: string; endpoint: string }>;
  prev: string | null;
  sig: string;
}

/**
 * com.atproto.identity.requestPlcOperationSignature
 *
 * For self-hosted single-user PDS: directly returns a signed PLC operation.
 *
 * Standard AT Protocol flow uses email tokens, but for self-hosted PDS we can
 * bypass that since we control the PLC rotation key. This matches the pattern
 * used in signPlcOperation but without requiring an email token.
 */
export async function POST({ locals, request }: APIContext) {
  const { env } = locals.runtime;

  if (!(await isAuthorized(request, env))) return unauthorized();

  try {
    const did = (await resolveSecret(env.PDS_DID)) ?? 'did:example:single-user';
    const handle = (await resolveSecret(env.PDS_HANDLE)) ?? 'example.com';
    const hostname = env.PDS_HOSTNAME ?? handle;

    // Load PLC rotation key
    const rotationKeyHex = await resolveSecret(env.PDS_PLC_ROTATION_KEY);
    if (!rotationKeyHex) {
      return new Response(
        JSON.stringify({
          error: 'InvalidRequest',
          message: 'PLC rotation key not configured. Set PDS_PLC_ROTATION_KEY secret.'
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const plcRotationKey = await Secp256k1Keypair.import(rotationKeyHex);

    // Load signing key
    const signingKeyHex = await resolveSecret(env.REPO_SIGNING_KEY);
    if (!signingKeyHex) {
      return new Response(
        JSON.stringify({
          error: 'InvalidRequest',
          message: 'Signing key not configured'
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const signingKey = await Secp256k1Keypair.import(signingKeyHex);

    // Fetch current PLC data (not audit log) - this gives us the latest state
    const plcResponse = await fetch(`https://plc.directory/${did}/data`);
    if (!plcResponse.ok) {
      return new Response(
        JSON.stringify({
          error: 'DidNotFound',
          message: 'Could not fetch DID document from PLC'
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const plcData = await plcResponse.json() as {
      did: string;
      rotationKeys: string[];
      verificationMethods?: Record<string, string>;
      alsoKnownAs?: string[];
      services?: Record<string, { type: string; endpoint: string }>;
    };

    // Fetch the audit log to get the prev CID
    const auditResponse = await fetch(`https://plc.directory/${did}/log/audit`);
    if (!auditResponse.ok) {
      return new Response(
        JSON.stringify({
          error: 'DidNotFound',
          message: 'Could not fetch PLC audit log'
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const auditLog = await auditResponse.json() as Array<{ cid: string; nullified: boolean }>;
    if (!auditLog || auditLog.length === 0) {
      return new Response(
        JSON.stringify({
          error: 'DidNotFound',
          message: 'No operations found for DID'
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const lastEntry = auditLog[auditLog.length - 1];
    if (lastEntry.nullified) {
      return new Response(
        JSON.stringify({
          error: 'InvalidRequest',
          message: 'DID is tombstoned'
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Create the new operation based on current data
    const newOp: Omit<PlcOperation, 'sig'> = {
      type: 'plc_operation',
      rotationKeys: plcData.rotationKeys,
      verificationMethods: {
        atproto: signingKey.did()
      },
      alsoKnownAs: [`at://${handle}`],
      services: {
        atproto_pds: {
          type: 'AtprotoPersonalDataServer',
          endpoint: `https://${hostname}`
        }
      },
      prev: lastEntry.cid
    };

    // Sign the operation
    const opBytes = uint8arrays.fromString(JSON.stringify(newOp), 'utf8');
    const sig = await plcRotationKey.sign(opBytes);
    const sigStr = uint8arrays.toString(sig, 'base64url');

    const operation: PlcOperation = {
      ...newOp,
      sig: sigStr
    };

    return new Response(
      JSON.stringify({ operation }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.error('PLC operation signing error:', error);
    return new Response(
      JSON.stringify({
        error: 'InternalServerError',
        message: error.message || 'Failed to generate PLC operation'
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}