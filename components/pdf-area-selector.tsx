"use client";

import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import type { AnswerPagePayload, NormalizedRect, SelectedQuestionRegionPayload } from "@/lib/types";
import { clonePdfBytes, cropCanvasToDataUrl, extractPdfTextSnippets, normalizeRect } from "@/lib/pdf-utils";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

type DraftRegion = {
  id: string;
  pageNumber: number;
  bounds: NormalizedRect;
};

interface PdfAreaSelectorProps {
  title: string;
  helperText: string;
  file: File | null;
  selectionMode: "region" | "page";
  accentLabel: string;
  onRegionsChange?: (regions: SelectedQuestionRegionPayload[]) => void;
  onPagesChange?: (pages: AnswerPagePayload[]) => void;
}

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function PdfAreaSelector({
  title,
  helperText,
  file,
  selectionMode,
  accentLabel,
  onRegionsChange,
  onPagesChange
}: PdfAreaSelectorProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const pageHostRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const canvasRefs = useRef<Record<number, HTMLCanvasElement | null>>({});

  const [numPages, setNumPages] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(680);
  const [documentData, setDocumentData] = useState<Uint8Array | null>(null);
  const [loadError, setLoadError] = useState("");
  const [textSnippets, setTextSnippets] = useState<Record<number, string>>({});
  const [regions, setRegions] = useState<DraftRegion[]>([]);
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const [dragging, setDragging] = useState<{
    pageNumber: number;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);

  useEffect(() => {
    if (!wrapperRef.current) {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      setViewportWidth(Math.max(320, Math.min(760, entry.contentRect.width - 12)));
    });

    observer.observe(wrapperRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setNumPages(0);
    setDocumentData(null);
    setLoadError("");
    setRegions([]);
    setSelectedPages([]);
    setTextSnippets({});
    canvasRefs.current = {};
    pageHostRefs.current = {};

    if (!file) {
      return;
    }

    let cancelled = false;

    startTransition(() => {
      file
        .arrayBuffer()
        .then(async (buffer) => {
          if (cancelled) {
            return;
          }

          const bytes = new Uint8Array(buffer);
          setDocumentData(clonePdfBytes(bytes));

          try {
            const snippets = await extractPdfTextSnippets(bytes);

            if (!cancelled) {
              setTextSnippets(snippets);
            }
          } catch {
            if (!cancelled) {
              setTextSnippets({});
            }
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setLoadError(
              error instanceof Error
                ? `PDF 파일을 열지 못했습니다. ${error.message}`
                : "PDF 파일을 열지 못했습니다. 다른 파일로 다시 시도해 주세요."
            );
          }
        });
    });

    return () => {
      cancelled = true;
    };
  }, [file]);

  useEffect(() => {
    if (selectionMode !== "region" || !onRegionsChange) {
      return;
    }

    const nextRegions = [...regions]
      .sort((a, b) => (a.pageNumber !== b.pageNumber ? a.pageNumber - b.pageNumber : a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x))
      .flatMap((region, index) => {
        const canvas = canvasRefs.current[region.pageNumber];

        if (!canvas) {
          return [];
        }

        const snapshotDataUrl = cropCanvasToDataUrl(canvas, region.bounds);
        const pageImageDataUrl = canvas.toDataURL("image/png");

        if (!snapshotDataUrl || !pageImageDataUrl) {
          return [];
        }

        return [
          {
            id: region.id,
            pageNumber: region.pageNumber,
            displayOrder: index + 1,
            bounds: region.bounds,
            snapshotDataUrl,
            pageImageDataUrl,
            extractedTextSnippet: textSnippets[region.pageNumber] ?? ""
          }
        ];
      });

    onRegionsChange(nextRegions);
  }, [onRegionsChange, regions, selectionMode, textSnippets]);

  useEffect(() => {
    if (selectionMode !== "page" || !onPagesChange) {
      return;
    }

    const nextPages = selectedPages.flatMap((pageNumber) => {
      const canvas = canvasRefs.current[pageNumber];

      if (!canvas) {
        return [];
      }

      return [
        {
          id: `answer-${pageNumber}`,
          pageNumber,
          pageImageDataUrl: canvas.toDataURL("image/png"),
          extractedTextSnippet: textSnippets[pageNumber] ?? ""
        }
      ];
    });

    onPagesChange(nextPages);
  }, [onPagesChange, selectedPages, selectionMode, textSnippets]);

  const previewRect = useMemo(() => {
    if (!dragging) {
      return null;
    }

    const canvas = canvasRefs.current[dragging.pageNumber];

    if (!canvas) {
      return null;
    }

    const rect = canvas.getBoundingClientRect();
    return normalizeRect(dragging.startX, dragging.startY, dragging.currentX, dragging.currentY, rect.width, rect.height);
  }, [dragging]);

  const documentSource = useMemo(() => {
    if (!documentData) {
      return null;
    }

    return { data: documentData };
  }, [documentData]);

  function beginSelection(event: React.PointerEvent<HTMLDivElement>, pageNumber: number) {
    if (selectionMode !== "region") {
      return;
    }

    const canvas = canvasRefs.current[pageNumber];

    if (!canvas) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    setDragging({
      pageNumber,
      startX: event.clientX - rect.left,
      startY: event.clientY - rect.top,
      currentX: event.clientX - rect.left,
      currentY: event.clientY - rect.top
    });
  }

  function updateSelection(event: React.PointerEvent<HTMLDivElement>, pageNumber: number) {
    if (!dragging || dragging.pageNumber !== pageNumber) {
      return;
    }

    const canvas = canvasRefs.current[pageNumber];

    if (!canvas) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    setDragging({
      ...dragging,
      currentX: event.clientX - rect.left,
      currentY: event.clientY - rect.top
    });
  }

  function completeSelection() {
    if (!dragging) {
      return;
    }

    const canvas = canvasRefs.current[dragging.pageNumber];

    if (!canvas) {
      setDragging(null);
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const normalized = normalizeRect(
      dragging.startX,
      dragging.startY,
      dragging.currentX,
      dragging.currentY,
      rect.width,
      rect.height
    );

    if (normalized.width < 0.04 || normalized.height < 0.04) {
      setDragging(null);
      return;
    }

    setRegions((current) => [
      ...current,
      {
        id: makeId("region"),
        pageNumber: dragging.pageNumber,
        bounds: normalized
      }
    ]);
    setDragging(null);
  }

  function togglePage(pageNumber: number) {
    setSelectedPages((current) =>
      current.includes(pageNumber) ? current.filter((value) => value !== pageNumber) : [...current, pageNumber].sort((a, b) => a - b)
    );
  }

  function registerCanvas(pageNumber: number) {
    const host = pageHostRefs.current[pageNumber];
    const canvas = host?.querySelector("canvas") ?? null;

    if (canvas instanceof HTMLCanvasElement) {
      canvasRefs.current[pageNumber] = canvas;
      setRegions((current) => [...current]);
      setSelectedPages((current) => [...current]);
    }
  }

  function removeRegion(regionId: string) {
    setRegions((current) => current.filter((region) => region.id !== regionId));
  }

  return (
    <div className="card pad selector-shell" ref={wrapperRef}>
      <div className="selector-head">
        <div>
          <h2 className="section-title">{title}</h2>
          <p className="subtle">{helperText}</p>
        </div>
        <span className="status warn">{accentLabel}</span>
      </div>

      {!file ? (
        <div className="empty">PDF를 업로드하면 여기에서 페이지 미리보기와 선택 도구가 나타납니다.</div>
      ) : loadError ? (
        <div className="empty">{loadError}</div>
      ) : (
        <>
          <div className="button-row">
            {selectionMode === "region" ? (
              <span className="status ok">선택한 문제 영역 {regions.length}개</span>
            ) : (
              <span className="status ok">선택한 답안 페이지 {selectedPages.length}개</span>
            )}
            <span className="subtle">텍스트가 적게 잡히는 스캔 PDF도 이미지 기준으로 계속 분석합니다.</span>
          </div>

          <Document
            key={file ? `${file.name}-${file.size}-${file.lastModified}` : "empty-pdf"}
            file={documentSource}
            loading={<div className="empty">PDF를 불러오는 중입니다.</div>}
            noData={<div className="empty">PDF 데이터를 준비하는 중입니다.</div>}
            error={<div className="empty">PDF 미리보기를 불러오지 못했습니다. 다른 PDF로 다시 시도해 주세요.</div>}
            onLoadSuccess={(document) => {
              setLoadError("");
              setNumPages(document.numPages);
            }}
            onLoadError={(error) => {
              setNumPages(0);
              setLoadError(
                error instanceof Error
                  ? `PDF를 불러오지 못했습니다. ${error.message}`
                  : "PDF를 불러오지 못했습니다. 다른 PDF로 다시 시도해 주세요."
              );
            }}
            onSourceError={(error) => {
              setNumPages(0);
              setLoadError(
                error instanceof Error
                  ? `PDF 원본을 읽지 못했습니다. ${error.message}`
                  : "PDF 원본을 읽지 못했습니다. 다시 업로드해 주세요."
              );
            }}
          >
            <div className="stack">
              {Array.from({ length: numPages }, (_, index) => {
                const pageNumber = index + 1;
                const pageRegions = regions.filter((region) => region.pageNumber === pageNumber);
                const isSelectedPage = selectedPages.includes(pageNumber);

                return (
                  <div className="page-card" key={pageNumber}>
                    <div className="page-header">
                      <div>
                        <strong>{pageNumber}페이지</strong>
                        <div className="subtle">
                          {textSnippets[pageNumber]
                            ? textSnippets[pageNumber]
                            : "텍스트가 거의 없는 스캔 PDF라면 이미지 분석과 페이지 위치 힌트로 매칭합니다."}
                        </div>
                      </div>

                      {selectionMode === "page" ? (
                        <button
                          type="button"
                          className={`toggle-card ${isSelectedPage ? "active" : ""}`}
                          onClick={() => togglePage(pageNumber)}
                        >
                          {isSelectedPage ? "답안 페이지 선택됨" : "이 페이지를 답안으로 사용"}
                        </button>
                      ) : null}
                    </div>

                    <div
                      className="pdf-stage"
                      ref={(node) => {
                        pageHostRefs.current[pageNumber] = node;
                      }}
                    >
                      <Page
                        pageNumber={pageNumber}
                        width={viewportWidth}
                        renderAnnotationLayer={false}
                        renderTextLayer={false}
                        loading={<div className="empty">페이지를 그리는 중입니다.</div>}
                        onRenderSuccess={() => registerCanvas(pageNumber)}
                      />

                      {selectionMode === "region" ? (
                        <div
                          className="overlay"
                          role="presentation"
                          onPointerDown={(event) => beginSelection(event, pageNumber)}
                          onPointerMove={(event) => updateSelection(event, pageNumber)}
                          onPointerUp={completeSelection}
                          onPointerLeave={completeSelection}
                        >
                          {pageRegions.map((region, localIndex) => (
                            <SelectionBox
                              key={region.id}
                              rect={region.bounds}
                              label={`${localIndex + 1}`}
                              onRemove={() => removeRegion(region.id)}
                            />
                          ))}

                          {previewRect && dragging?.pageNumber === pageNumber ? <SelectionBox rect={previewRect} preview /> : null}
                        </div>
                      ) : null}
                    </div>

                    {selectionMode === "region" && pageRegions.length > 0 ? (
                      <div className="selection-meta">
                        {pageRegions.map((region, localIndex) => (
                          <button key={region.id} type="button" className="selection-chip active" onClick={() => removeRegion(region.id)}>
                            <strong>
                              {pageNumber}페이지 영역 {localIndex + 1}
                            </strong>
                            <span className="subtle">잘못 선택했다면 눌러서 제거</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </Document>
        </>
      )}
    </div>
  );
}

function SelectionBox({
  rect,
  label,
  preview,
  onRemove
}: {
  rect: NormalizedRect;
  label?: string;
  preview?: boolean;
  onRemove?: () => void;
}) {
  return (
    <div
      className={`selection-box ${preview ? "preview" : ""}`}
      style={{
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        width: `${rect.width * 100}%`,
        height: `${rect.height * 100}%`
      }}
      onDoubleClick={onRemove}
    >
      {label ? <span className="selection-label">{label}</span> : null}
    </div>
  );
}
