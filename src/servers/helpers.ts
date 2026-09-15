export function buildSearchParams(params: Record<string, any>): URLSearchParams {
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      // comma-joined so downstream parses a single key (repeated keys are ambiguous)
      searchParams.append(key, value.join(','));
    } else {
      searchParams.append(key, String(value));
    }
  }

  return searchParams;
}
