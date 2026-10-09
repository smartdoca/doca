const maximumSeconds = 2_147_483_647;

/** Deployment policy for new logins and the existing mobile renewal flow. */
export function sessionDurations(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const seconds = (name: string, defaultValue: number) => {
    const raw = environment[name];
    if (raw === undefined) return defaultValue;
    if (!/^[1-9][0-9]*$/.test(raw))
      throw new Error(`${name} must be a positive integer in seconds`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value > maximumSeconds)
      throw new Error(`${name} must be at most ${maximumSeconds} seconds`);
    return value;
  };
  return {
    browserSeconds: seconds("DOCA_SESSION_TTL_SECONDS", 86_400),
    mobileSeconds: seconds("DOCA_MOBILE_SESSION_TTL_SECONDS", 15_552_000),
  };
}
