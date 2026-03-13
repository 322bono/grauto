"use client";

import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page } from "react-pdf";
import { ensurePdfWorker } from "@/lib/pdf-worker";
import type { AnswerPagePayload, SelectedQuestionRegionPayload } from "@/lib/types";
import {
  canvasToCompressedDataUrl,
  clonePdfBytes,
  cropCanvasToDataUrl,
  detectQuestionBandsFromCanvas,
  extractPdfQuestionRegions,
  extractPdfTextSnippets
} from "@/lib/pdf-utils";

ensurePdfWorker();

interface DetectedQuestionSlice {
  questionNumber: number | null;
  bounds: SelectedQuestionRegionPayload["bounds"];
  textSnippet: string;
}

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
  const [containerWidth, setContainerWidth] = useState(680);
  const [documentData, setDocumentData] = useState<Uint8Array | null>(null);
  const [loadError, setLoadError] = useState("");
  const [textSnippets, setTextSnippets] = useState<Record<number, string>>({});
  const [questionRegionsByPage, setQuestionRegionsByPage] = useState<Record<number, DetectedQuestionSlice[]>>({});
  const [selectedPages, setSelectedPages] = useState<number[]>([]);

  useEffect(() => {
    if (!wrapperRef.current) {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      setContainerWidth(Math.max(320, Math.min(1200, entry.contentRect.width - 12)));
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
    setQuestionRegionsByPage({});
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
            const [snippets, detectedRegions] = await Promise.all([
              extractPdfTextSnippets(bytes),
              selectionMode === "region" ? extractPdfQuestionRegions(bytes) : Promise.resolve({})
            ]);

            if (!cancelled) {
              setTextSnippets(snippets);
              setQuestionRegionsByPage(detectedRegions as Record<number, DetectedQuestionSlice[]>);
            }
          } catch {
            if (!cancelled) {
              setTextSnippets({});
              setQuestionRegionsByPage({});
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
  }, [file, selectionMode]);

  const selectedQuestionCount = useMemo(
    () =>
      selectedPages.reduce((count, pageNumber) => {
        const detectedCount = questionRegionsByPage[pageNumber]?.length ?? 0;
        return count + Math.max(1, detectedCount);
      }, 0),
    [questionRegionsByPage, selectedPages]
  );

  useEffect(() => {
    if (selectionMode !== "region" || !onRegionsChange) {
      return;
    }

    const nextRegions = [...selectedPages]
      .sort((a, b) => a - b)
      .flatMap((pageNumber) => {
        const canvas = canvasRefs.current[pageNumber];

        if (!canvas) {
          return [];
        }

        const regionSlices =
          questionRegionsByPage[pageNumber]?.length > 0
            ? questionRegionsByPage[pageNumber]
            : detectQuestionBandsFromCanvas(canvas).map((bounds, index) => ({
                questionNumber: null,
                bounds,
                textSnippet: textSnippets[pageNumber] ? `${textSnippets[pageNumber]} #${index + 1}` : ""
              }));

        return regionSlices.flatMap((region, regionIndex) => {
          const snapshotDataUrl = cropCanvasToDataUrl(canvas, region.bounds);

          if (!snapshotDataUrl) {
            return [];
          }

          return [
            {
              id: `question-page-${pageNumber}-${region.questionNumber ?? regionIndex + 1}-${regionIndex}`,
              pageNumber,
              displayOrder: 0,
              bounds: region.bounds,
              snapshotDataUrl,
              extractedTextSnippet: region.textSnippet || textSnippets[pageNumber] || "",
              questionNumberHint: region.questionNumber
            }
          ];
        });
      })
      .map((region, index) => ({
        ...region,
        displayOrder: index + 1
      }));

    onRegionsChange(nextRegions);
  }, [onRegionsChange, questionRegionsByPage, selectedPages, selectionMode, textSnippets]);

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

        const pageImageDataUrl = canvasToCompressedDataUrl(canvas, {
          maxWidth: 176,
          mimeType: "image/jpeg",
          quality: 0.72
        });

        if (!pageImageDataUrl) {
          return [];
        }

        return [
          {
            id: `answer-${pageNumber}`,
            pageNumber,
            pageImageDataUrl,
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

  const thumbnailWidth = useMemo(() => {
    if (containerWidth >= 980) {
      return 210;
    }

    if (containerWidth >= 720) {
      return 190;
    }

    if (containerWidth >= 480) {
      return 160;
    }

    return 132;
  }, [containerWidth]);

  function togglePage(pageNumber: number) {
    setSelectedPages((current) =>
      current.includes(pageNumber) ? current.filter((value) => value !== pageNumber) : [...current, pageNumber].sort((a, b) => a - b)
    );
  }

  function selectAllPages() {
    setSelectedPages(Array.from({ length: numPages }, (_, index) => index + 1));
  }

  function clearSelection() {
    setSelectedPages([]);
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
          <div className="selector-toolbar">
            <div className="button-row">
              <span className="status ok">
                {selectionMode === "region" ? `선택된 문제 문항 ${selectedQuestionCount}개` : `선택한 답안 페이지 ${selectedPages.length}개`}
              </span>
              <span className="subtle">
                {selectionMode === "region"
                  ? "페이지를 누르면 그 안의 문항을 자동으로 잘라서 사용합니다."
                  : "정답과 해설이 있는 페이지를 눌러 빠르게 골라 주세요."}
              </span>
            </div>

            <div className="button-row">
              <button type="button" className="cta ghost compact" onClick={selectAllPages} disabled={numPages === 0}>
                전체 선택
              </button>
              <button type="button" className="cta ghost compact" onClick={clearSelection} disabled={selectedPages.length === 0}>
                전체 해제
              </button>
            </div>
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
                error instanceof Error ? `PDF를 불러오지 못했습니다. ${error.message}` : "PDF를 불러오지 못했습니다."
              );
            }}
            onSourceError={(error) => {
              setNumPages(0);
              setLoadError(
                error instanceof Error ? `PDF 원본을 읽지 못했습니다. ${error.message}` : "PDF 원본을 읽지 못했습니다."
              );
            }}
          >
            <div className="pdf-thumb-grid">
              {Array.from({ length: numPages }, (_, index) => {
                const pageNumber = index + 1;
                const isSelectedPage = selectedPages.includes(pageNumber);
                const detectedQuestionCount = questionRegionsByPage[pageNumber]?.length ?? 0;

                return (
                  <button
                    key={pageNumber}
                    type="button"
                    className={`page-card page-card-button ${isSelectedPage ? "active" : ""}`}
                    onClick={() => togglePage(pageNumber)}
                  >
                    <div className="page-header">
                      <strong>{pageNumber}페이지</strong>
                      <span className={`status ${isSelectedPage ? "ok" : "warn"}`}>
                        {selectionMode === "region" ? (isSelectedPage ? "문제" : "선택") : isSelectedPage ? "답안" : "선택"}
                      </span>
                    </div>

                    <div
                      className="pdf-stage compact"
                      ref={(node) => {
                        pageHostRefs.current[pageNumber] = node;
                      }}
                    >
                      <Page
                        pageNumber={pageNumber}
                        width={thumbnailWidth}
                        renderAnnotationLayer={false}
                        renderTextLayer={false}
                        loading={<div className="empty">페이지 로딩 중</div>}
                        onRenderSuccess={() => registerCanvas(pageNumber)}
                      />
                    </div>

                    <div className="page-card-footer">
                      <span className="subtle line-clamp-2">
                        {textSnippets[pageNumber] ? textSnippets[pageNumber] : "텍스트가 적은 스캔 PDF면 썸네일을 보고 선택해 주세요."}
                      </span>
                      {selectionMode === "region" ? (
                        <span className="subtle" style={{ display: "block", marginTop: 8 }}>
                          감지 문항 {detectedQuestionCount > 0 ? detectedQuestionCount : "자동 분리 준비 중"}
                        </span>
                      ) : null}
                    </div>
                  </button>
                );
              })}
            </div>
          </Document>
        </>
      )}
    </div>
  );
}
