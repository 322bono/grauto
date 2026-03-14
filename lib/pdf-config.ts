export const PDF_DOCUMENT_OPTIONS = {
  cMapUrl: "/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "/standard_fonts/"
} as const;

export function buildPdfDocumentInit(data: Uint8Array) {
  return {
    data,
    ...PDF_DOCUMENT_OPTIONS
  };
}
