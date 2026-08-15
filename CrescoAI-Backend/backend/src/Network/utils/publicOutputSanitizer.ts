import { basename } from 'node:path';

// A drive letter must not be embedded in another word. Without this guard, the
// trailing `s:/` in `https://...` is mistaken for a Windows path and sanitized.
const WINDOWS_FILE_PATH_PATTERN = /(?<![A-Za-z0-9_])(?:[A-Za-z]:|\\\\[^\\/\s]+[\\/]+[^\\/\s]+)[\\/]+(?:[^\\/\r\n"'`<>|?*]+[\\/]+)+[^\\/\r\n"'`<>|?*]*?\.[A-Za-z0-9]{1,12}/g;
const WINDOWS_PATH_TOKEN_PATTERN = /(?<![A-Za-z0-9_])(?:[A-Za-z]:|\\\\[^\\/\s]+[\\/]+[^\\/\s]+)[\\/]+(?:[^\s"'`<>|?*,;:()\[\]{}]+[\\/]+)*[^\s"'`<>|?*,;:()\[\]{}]*/g;
const UNIX_FILE_PATH_PATTERN = /\/(?:home|Users|var|tmp|opt|srv|root|workspace|mnt|git)(?:\/[^/\r\n"'`<>|?*]+)+?\/[^/\r\n"'`<>|?*]*?\.[A-Za-z0-9]{1,12}/g;
const UNIX_PATH_TOKEN_PATTERN = /\/(?:home|Users|var|tmp|opt|srv|root|workspace|mnt|git)(?:\/[^\s"'`<>|?*,;:()\[\]{}]+)+/g;
const NETWORK_RELATIVE_PATH_PATTERN = /(?:\.\.?[\\/]+)?(?:(?:CrescoAI-Backend|backend)[\\/]+)?src[\\/]+Network[\\/]+(?:user|files)(?:[\\/]+[^\s"'`<>|?*,;:()\[\]{}]+)+/gi;

export function sanitizeServerPhysicalPaths(input: string): string {
  if (!input) {
    return input;
  }

  let output = input.replace(/`([^`\r\n]+)`/g, (match, value: string) => {
    if (!looksLikeServerPhysicalPath(value.trim())) {
      return match;
    }
    return `\`${safePathLabel(value)}\``;
  });

  output = output.replace(WINDOWS_FILE_PATH_PATTERN, safePathLabel);
  output = output.replace(UNIX_FILE_PATH_PATTERN, safePathLabel);
  output = output.replace(NETWORK_RELATIVE_PATH_PATTERN, safePathLabel);
  output = output.replace(WINDOWS_PATH_TOKEN_PATTERN, safePathLabel);
  output = output.replace(UNIX_PATH_TOKEN_PATTERN, safePathLabel);
  return output;
}

export function looksLikeServerPhysicalPath(value: string): boolean {
  const normalized = value.trim().replace(/\\\\/g, '\\').replace(/\\\//g, '/');
  return (
    /^[A-Za-z]:[\\/]/.test(normalized) ||
    /^(?:\\\\|\/\/)[^\\/]/.test(normalized) ||
    /^\/(?:home|Users|var|tmp|opt|srv|root|workspace|mnt|git)(?:\/|$)/.test(normalized) ||
    /^(?:\.\.?[\\/]+)?(?:(?:CrescoAI-Backend|backend)[\\/]+)?src[\\/]+Network[\\/]+(?:user|files)(?:[\\/]|$)/i.test(normalized) ||
    /^file:\/\//i.test(normalized)
  );
}

export function sanitizeServerPhysicalPathsInValue<T>(value: T): T {
  if (typeof value === 'string') {
    return sanitizeServerPhysicalPaths(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeServerPhysicalPathsInValue(item)) as T;
  }
  if (typeof value !== 'object' || value === null || value instanceof Date) {
    return value;
  }

  const sanitized = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizeServerPhysicalPathsInValue(item)]),
  );
  return sanitized as T;
}

function safePathLabel(rawPath: string) {
  const normalized = rawPath
    .trim()
    .replace(/^file:\/\//i, '')
    .replace(/\\\\/g, '\\')
    .replace(/[),.;:]+$/, '');
  const name = basename(normalized.replace(/\\/g, '/'));
  return name && /\.[A-Za-z0-9]{1,12}$/.test(name) ? name : '生成资源';
}
