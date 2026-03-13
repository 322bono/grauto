"use client";

import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page } from "react-pdf";
import { ensurePdfWorker } from "@/lib/pdf-worker";
import type { AnswerPagePayload, SelectedQuestionRegionPayload } from "@/lib/types";
import { clonePdfBytes, cropCanvasToDataUrl, extractPdfTextSnippets } from "@/lib/pdf-utils";

ensurePdfWorker();

const QUESTION_PAGE_BOUNDS = {
  x: 0.05,
  y: 0.06,
  width: 0.9,
  height: 0.88
} as const;

interface PdfAreaSelectorProps {
  title: string;
  helperText: string;
  file: File | null;
  selectionMode: "region" | "page";
  accentLabel: string;
  onRegionsChange?: (regions: SelectedQuestionRegionPayload[]) => void;
  onPagesChange?: (pages: AnswerPagePayload[]) => void;
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
  const [selectedPages, setSelectedPages] = useState<number[]>([]);

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
                ? `PDF 파일을 읽지 못했습니다. ${error.message}`
                : "PDF 파일을 읽지 못했습니다. 다른 파일로 다시 시도해 주세요."
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

    const nextRegions = [...selectedPages]
      .sort((a, b) => a - b)
      .flatMap((pageNumber, index) => {
        const canvas = canvasRefs.current[pageNumber];

        if (!canvas) {
          return [];
        }

        const snapshotDataUrl = cropCanvasToDataUrl(canvas, QUESTION_PAGE_BOUNDS);
        const pageImageDataUrl = canvas.toDataURL("image/png");

        if (!snapshotDataUrl || !pageImageDataUrl) {
          return [];
        }

        return [
          {
            id: `question-page-${pageNumber}`,
            pageNumber,
            displayOrder: index + 1,
            bounds: QUESTION_PAGE_BOUNDS,
            snapshotDataUrl,
            pageImageDataUrl,
            extractedTextSnippet: textSnippets[pageNumber] ?? ""
          }
        ];
      });

    onRegionsChange(nextRegions);
  }, [onRegionsChange, selectedPages, selectionMode, textSnippets]);

  useEffect(() => {
    if (selectionMode !== "page" || !onPagesChange) {
      return;
    }

    const nextPages = [...selectedPages]
      .sort((a, b) => a - b)
      .flatMap((pageNumber) => {
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

  const documentSource = useMemo(() => {
    if (!documentData) {
      return null;
    }

    return { data: documentData };
  }, [documentData]);

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
      setSelectedPages((current) => [...current]);
    }
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
        <div className="empty">PDF를 업로드하면 여기에서 페이지 미리보기와 선택 버튼이 표시됩니다.</div>
      ) : loadError ? (
        <div className="empty">{loadError}</div>
      ) : (
        <>
          <div className="button-row">
            <span className="status ok">
              {selectionMode === "region" ? `선택한 문제 페이지 ${selectedPages.length}개` : `선택한 답안 페이지 ${selectedPages.length}개`}
            </span>
            <span className="subtle">
              {selectionMode === "region"
                ? "페이지를 누르면 여백을 제외한 문제 부분만 자동으로 사용합니다."
                : "정답과 해설이 들어 있는 페이지를 눌러 선택해 주세요."}
            </span>
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
                const isSelectedPage = selectedPages.includes(pageNumber);

                return (
                  <div className={`page-card ${isSelectedPage ? "active" : ""}`} key={pageNumber}>
                    <div className="page-header">
                      <div>
                        <strong>{pageNumber}페이지</strong>
                        <div className="subtle">
                          {textSnippets[pageNumber]
                            ? textSnippets[pageNumber]
                            : "텍스트가 거의 없는 스캔 PDF라면 이미지 미리보기를 보고 선택해 주세요."}
                        </div>
                      </div>

                      <button
                        type="button"
                        className={`toggle-card ${isSelectedPage ? "active" : ""}`}
                        onClick={() => togglePage(pageNumber)}
                      >
                        {selectionMode === "region"
                          ? isSelectedPage
                            ? "문제로 선택됨"
                            : "이 페이지를 문제로 사용"
                          : isSelectedPage
                            ? "답안으로 선택됨"
                            : "이 페이지를 답안으로 사용"}
                      </button>
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
                    </div>
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
