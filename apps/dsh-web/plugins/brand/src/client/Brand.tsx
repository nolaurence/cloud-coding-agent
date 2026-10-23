/** CCA occupants for the generic DeepSeek Harness sidebar brand slots. */

/**
 * Render the product mark at the size the sidebar requests.
 * @param props.size - Host-selected glyph size in CSS pixels.
 * @returns the mark, or nothing when the deployment ships no asset.
 */
export function CcaBrandMark({ size = 24 }: { size?: number }) {
  return (
    <img
      src="kloud-logo.svg"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      style={{ display: "block" }}
    />
  );
}

/**
 * Render the product wordmark without its independently slotted mark.
 * @returns the sidebar wordmark.
 */
export function CcaBrandName() {
  return (
    <span style={{ fontWeight: 600, letterSpacing: "-0.01em" }}>
      Kloud Work
    </span>
  );
}
