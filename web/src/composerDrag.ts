export function dragContainsFiles(dataTransfer: Pick<DataTransfer, "types"> | null | undefined): boolean {
  return Array.from(dataTransfer?.types ?? []).includes("Files");
}
