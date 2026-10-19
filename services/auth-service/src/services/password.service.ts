import argon2 from 'argon2';

export class PasswordService {
  /**
   * Hashes a password using Argon2id with recommended OWASP memory and time limits
   */
  public static async hash(password: string): Promise<string> {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 2 ** 16, // 64 MB memory
      timeCost: 3,         // 3 iterations
      parallelism: 1,
    });
  }

  /**
   * Verifies a plain text password against an Argon2id hash
   */
  public static async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }
}
