/** Some macOS IMEs end composition before dispatching the confirming keydown;
 * legacy keyCode 229 still identifies that event in those browsers. */
export function isCompositionKey(event: { isComposing?: boolean; keyCode?: number }): boolean {
  return event.isComposing === true || event.keyCode === 229;
}
