// A Matrix user ID: @localpart:server, at most 255 characters, where the server is a host name, an IPv4 address or a
// bracketed IPv6 address, with an optional port.
const MATRIX_USER_ID = /^@[^\s:@]+:(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;
export const MATRIX_USER_ID_MAX_LENGTH = 255;

export function isMatrixUserId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MATRIX_USER_ID_MAX_LENGTH && MATRIX_USER_ID.test(value);
}
