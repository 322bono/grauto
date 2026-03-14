export const PLACEHOLDER_IMAGE_DATA_URL =
  "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=";

export function isPlaceholderImageDataUrl(value: string | undefined | null) {
  return !value || value === PLACEHOLDER_IMAGE_DATA_URL;
}
