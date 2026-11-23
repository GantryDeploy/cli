/** `v12`, or the version id on a preview environment, whose builds take no number. */
export function versionTag(versionId: string, versionNumber: number | null): string {
  return versionNumber === null ? versionId : `v${String(versionNumber)}`
}
