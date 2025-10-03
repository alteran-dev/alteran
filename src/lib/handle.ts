/**
 * Handle validation and normalization utilities
 *
 * Handles must:
 * - Be lowercase
 * - Contain only alphanumeric characters, dots, and hyphens
 * - Not start or end with dots or hyphens
 * - Have valid TLD
 */

/**
 * Validate handle format
 */
export function isValidHandle(handle: string): boolean {
  if (!handle || typeof handle !== 'string') {
    return false;
  }

  // Must be lowercase
  if (handle !== handle.toLowerCase()) {
    return false;
  }

  // Length constraints (3-253 characters)
  if (handle.length < 3 || handle.length > 253) {
    return false;
  }

  // Must match pattern: alphanumeric, dots, hyphens
  // Cannot start/end with dot or hyphen
  const handleRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
  if (!handleRegex.test(handle)) {
    return false;
  }

  // Must have at least one dot (domain requirement)
  if (!handle.includes('.')) {
    return false;
  }

  // Check TLD is valid (at least 2 characters)
  const parts = handle.split('.');
  const tld = parts[parts.length - 1];
  if (tld.length < 2) {
    return false;
  }

  // No consecutive dots
  if (handle.includes('..')) {
    return false;
  }

  // No consecutive hyphens
  if (handle.includes('--')) {
    return false;
  }

  return true;
}

/**
 * Normalize handle (lowercase, trim)
 */
export function normalizeHandle(handle: string): string {
  return handle.toLowerCase().trim();
}

/**
 * Validate and normalize handle
 */
export function validateAndNormalizeHandle(handle: string): string | null {
  const normalized = normalizeHandle(handle);
  return isValidHandle(normalized) ? normalized : null;
}

/**
 * Extract domain from handle
 */
export function getHandleDomain(handle: string): string {
  const parts = handle.split('.');
  return parts.slice(-2).join('.');
}

/**
 * Check if handle is a subdomain
 */
export function isSubdomain(handle: string): boolean {
  const parts = handle.split('.');
  return parts.length > 2;
}