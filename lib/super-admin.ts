/**
 * Super Admin Utility Functions
 * 
 * Determines if a user is a super admin based on their email address.
 * Super admins are defined via the SUPER_ADMINS environment variable.
 */

/**
 * Check if an email address belongs to a super admin
 * @param email - The email address to check (can be null)
 * @returns true if the email is in the SUPER_ADMINS list, false otherwise
 */
export function isSuperAdmin(email: string | null): boolean {
  if (!email) {
    return false;
  }

  const superAdminsEnv = process.env.SUPER_ADMINS;
  if (!superAdminsEnv) {
    return false;
  }

  // Parse comma-separated list, trim whitespace, and convert to lowercase for comparison
  const superAdminEmails = superAdminsEnv
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);

  // Case-insensitive comparison
  const normalizedEmail = email.trim().toLowerCase();

  return superAdminEmails.includes(normalizedEmail);
}

