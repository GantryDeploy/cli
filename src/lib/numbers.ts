export function parseNumber(raw: string, whole: boolean): number | null {
  const value = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(value) || (whole && !Number.isInteger(value))) {
    return null
  }
  return value
}

export function notANumberMessage(flag: string, whole: boolean): string {
  return `${flag} must be a ${whole ? 'whole number' : 'number'}.`
}
