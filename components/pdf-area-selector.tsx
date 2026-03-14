"use client";

import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { PLACEHOLDER_IMAGE_DATA_URL } from "@/lib/image-placeholder";
import { buildPdfDocumentInit, PDF_DOCUMENT_OPTIONS } from "@/lib/pdf-config";
import { ensurePdfWorker } from "@/lib/pdf-worker";
import type {
  AnswerPagePayload,
  PageNumberAnchor,
  SegmentRequestPayload,
  SegmentResponsePayload,
  SelectedQuestionRegionPayload,
} from "@/lib/types";
import {
  canvasToCompressedDataUrl,
  clonePdfBytes,
  cropCanvasToCompressedDataUrl,
  extractPdfAnswerRegions,
  extractPdfQuestionRegions,
  extractPdfTextSnippets,
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

const SEGMENT_BATCH_SIZE = 8;

export function PdfAreaSelector({
  title,
  helperText,
  file,
  selectionMode,
  accentLabel,
  onRegionsChange,
  onPagesChange,
}: PdfAreaSelectorProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const pageHostRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const canvasRefs = useRef<Record<number, HTMLCanvasElement | null>>({});
  const selectedPagesRef = useRef<number[]>([]);
  const localQuestionRegionsRef = useRef<Record<number, DetectedQuestionSlice[]> | null>(null);
  const localAnswerAnchorsRef = useRef<Record<number, PageNumberAnchor[]> | null>(null);

  const [numPages, setNumPages] = useState(0);
  const [containerWidth, setContainerWidth] = useState(680);
  const [documentData, setDocumentData] = useState<Uint8Array | null>(null);
  const [loadError, setLoadError] = useState("");
  const [textSnippets, setTextSnippets] = useState<Record<number, string>>({});
  const [questionRegionsByPage, setQuestionRegionsByPage] = useState<Record<number, DetectedQuestionSlice[]>>({});
  const [answerAnchorsByPage, setAnswerAnchorsByPage] = useState<Record<number, PageNumberAnchor[]>>({});
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const [segmentStatusByPage, setSegmentStatusByPage] = useState<Record<string, "idle" | "loading" | "ready" | "error">>({});

  useEffect(() => {
    selectedPagesRef.current = selectedPages;
  }, [selectedPages]);

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
    setAnswerAnchorsByPage({});
    setSegmentStatusByPage({});
    canvasRefs.current = {};
    pageHostRefs.current = {};
    localQuestionRegionsRef.current = null;
    localAnswerAnchorsRef.current = null;

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
                ? `PDF 파일을 불러오지 못했습니다. ${error.message}`
                : "PDF 파일을 불러오지 못했습니다. 다른 파일로 다시 시도해 주세요."
            );
          }
        });
    });

    return () => {
      cancelled = true;
    };
  }, [file, selectionMode]);

  function getSegmentStatusKey(pageNumber: number) {
    return `${selectionMode}:${pageNumber}`;
  }

  function getSegmentStatus(pageNumber: number) {
    return segmentStatusByPage[getSegmentStatusKey(pageNumber)] ?? "idle";
  }

  function markPagesStatus(pageNumbers: number[], status: "loading" | "ready" | "error") {
    setSegmentStatusByPage((current) => ({
      ...current,
      ...Object.fromEntries(pageNumbers.map((pageNumber) => [getSegmentStatusKey(pageNumber), status])),
    }));
  }

  function applySegmentedPages(payload: SegmentResponsePayload) {
    if (payload.mode === "questions") {
      setQuestionRegionsByPage((current) => {
        const next = { ...current };

        for (const page of payload.pages) {
          next[page.pageNumber] = (page.questionRegions ?? []).map((region) => ({
            questionNumber: region.questionNumber ?? null,
            bounds: region.bounds,
            textSnippet: region.textSnippet ?? textSnippets[page.pageNumber] ?? "",
          }));
        }

        return next;
      });

      return;
    }

    setAnswerAnchorsByPage((current) => {
      const next = { ...current };

      for (const page of payload.pages) {
        next[page.pageNumber] = (page.answerAnchors ?? []).map((anchor) => ({
          questionNumber: anchor.questionNumber ?? null,
          bounds: anchor.bounds,
          textSnippet: anchor.textSnippet ?? textSnippets[page.pageNumber] ?? "",
          segments: anchor.segments ?? [anchor.bounds],
        }));
      }

      return next;
    });
  }

  async function applyLocalSegmentation(pageNumbers: number[]) {
    if (!documentData || pageNumbers.length === 0) {
      return false;
    }

    try {
      if (selectionMode === "region") {
        if (!localQuestionRegionsRef.current) {
          localQuestionRegionsRef.current = await extractPdfQuestionRegions(clonePdfBytes(documentData));
        }

        const localPages = localQuestionRegionsRef.current;

        setQuestionRegionsByPage((current) => {
          const next = { ...current };

          for (const pageNumber of pageNumbers) {
            next[pageNumber] = localPages[pageNumber] ?? [];
          }

          return next;
        });
      } else {
        if (!localAnswerAnchorsRef.current) {
          localAnswerAnchorsRef.current = await extractPdfAnswerRegions(clonePdfBytes(documentData));
        }

        const localPages = localAnswerAnchorsRef.current;

        setAnswerAnchorsByPage((current) => {
          const next = { ...current };

          for (const pageNumber of pageNumbers) {
            next[pageNumber] = localPages[pageNumber] ?? [];
          }

          return next;
        });
      }

      markPagesStatus(pageNumbers, "ready");
      setLoadError("");
      return true;
    } catch {
      return false;
    }
  }

  async function requestSegmentationBatch(pageNumbers: number[]) {
    const pendingPages: Array<SegmentRequestPayload["pages"][number] | null> = pageNumbers.map((pageNumber) => {
        const canvas = canvasRefs.current[pageNumber];
        const status = getSegmentStatus(pageNumber);

        if (!canvas || status === "loading" || status === "ready") {
          return null;
        }

        const pageImageDataUrl = canvasToCompressedDataUrl(canvas, {
          maxWidth: 960,
          mimeType: "image/jpeg",
          quality: 0.78,
        });

        if (!pageImageDataUrl) {
          return null;
        }

        return {
          pageNumber,
          pageImageDataUrl,
          textSnippet: textSnippets[pageNumber] ?? "",
        };
      });

    const pages = pendingPages
      .filter((page): page is SegmentRequestPayload["pages"][number] => page !== null)
      .slice(0, SEGMENT_BATCH_SIZE);

    if (pages.length === 0) {
      return;
    }

    markPagesStatus(
      pages.map((page) => page.pageNumber),
      "loading"
    );

    try {
      const response = await fetch("/api/segment", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mode: selectionMode === "region" ? "questions" : "answers",
          pages,
        } satisfies SegmentRequestPayload),
      });

      if (!response.ok) {
        throw new Error(`${response.status}:${await response.text()}`);
      }

      const payload = (await response.json()) as SegmentResponsePayload;
      applySegmentedPages(payload);
      markPagesStatus(
        pages.map((page) => page.pageNumber),
        "ready"
      );
      setLoadError("");
    } catch (error) {
      const restored = await applyLocalSegmentation(pages.map((page) => page.pageNumber));

      if (restored) {
        return;
      }

      markPagesStatus(
        pages.map((page) => page.pageNumber),
        "error"
      );
      setLoadError(
        error instanceof Error
          ? `AI 분리에 실패했습니다. ${error.message}`
          : "AI 분리에 실패했습니다. 잠시 후 다시 시도해 주세요."
      );
    }
  }

  useEffect(() => {
    const hasLoadingPage = selectedPages.some((pageNumber) => getSegmentStatus(pageNumber) === "loading");

    if (hasLoadingPage) {
      return;
    }

    const pendingPages = selectedPages.filter((pageNumber) => {
      const canvas = canvasRefs.current[pageNumber];
      const status = getSegmentStatus(pageNumber);
      return Boolean(canvas) && status !== "loading" && status !== "ready";
    });

    if (pendingPages.length === 0) {
      return;
    }

    void requestSegmentationBatch(pendingPages);
  }, [selectedPages, selectionMode, segmentStatusByPage, textSnippets]);

  const selectedQuestionCount = useMemo(
    () =>
      selectedPages.reduce((count, pageNumber) => {
        const detectedCount = questionRegionsByPage[pageNumber]?.length ?? 0;
        return count + detectedCount;
      }, 0),
    [questionRegionsByPage, selectedPages]
  );

  useEffect(() => {
    if (selectionMode !== "region" || !onRegionsChange) {
      return;
    }

    if (!documentData || selectedPages.length === 0) {
      onRegionsChange([]);
      return;
    }

    let cancelled = false;

    onRegionsChange(buildQuickRegions(selectedPages));

    startTransition(() => {
      (async () => {
        const pdfDocument = await pdfjs.getDocument(buildPdfDocumentInit(clonePdfBytes(documentData))).promise;

        try {
          const nextRegions: SelectedQuestionRegionPayload[] = [];

          for (const pageNumber of [...selectedPages].sort((a, b) => a - b)) {
            const page = await pdfDocument.getPage(pageNumber);
            const baseViewport = page.getViewport({ scale: 1 });
            const scale = Math.max(1.8, 1320 / Math.max(1, baseViewport.width));
            const viewport = page.getViewport({ scale });
            const renderCanvas = document.createElement("canvas");
            renderCanvas.width = Math.round(viewport.width);
            renderCanvas.height = Math.round(viewport.height);
            const context = renderCanvas.getContext("2d", { alpha: false });

            if (!context) {
              continue;
            }

            await page.render({ canvasContext: context, viewport }).promise;

            for (const [regionIndex, region] of (questionRegionsByPage[pageNumber] ?? []).entries()) {
              const snapshotDataUrl = cropCanvasToCompressedDataUrl(renderCanvas, region.bounds, {
                maxWidth: 900,
                mimeType: "image/jpeg",
                quality: 0.9,
              });
              const analysisDataUrl = cropCanvasToCompressedDataUrl(renderCanvas, region.bounds, {
                maxWidth: 520,
                mimeType: "image/jpeg",
                quality: 0.74,
              });

              if (!snapshotDataUrl) {
                continue;
              }

              nextRegions.push({
                id: `question-page-${pageNumber}-${region.questionNumber ?? regionIndex + 1}-${regionIndex}`,
                pageNumber,
                displayOrder: 0,
                bounds: region.bounds,
                snapshotDataUrl,
                analysisDataUrl: analysisDataUrl || snapshotDataUrl,
                extractedTextSnippet: region.textSnippet || textSnippets[pageNumber] || "",
                questionNumberHint: region.questionNumber,
              });
            }
          }

          if (!cancelled) {
            onRegionsChange(
              nextRegions.map((region, index) => ({
                ...region,
                displayOrder: index + 1,
              }))
            );
          }
        } finally {
          void pdfDocument.destroy();
        }
      })().catch(() => {
        // Keep the quick selection when high-resolution regeneration fails.
      });
    });

    return () => {
      cancelled = true;
    };
  }, [documentData, onRegionsChange, questionRegionsByPage, selectedPages, selectionMode, textSnippets]);

  useEffect(() => {
    if (selectionMode !== "page" || !onPagesChange) {
      return;
    }

    if (!documentData || selectedPages.length === 0) {
      onPagesChange([]);
      return;
    }

    let cancelled = false;

    onPagesChange(buildQuickPages(selectedPages));

    startTransition(() => {
      (async () => {
        const pdfDocument = await pdfjs.getDocument(buildPdfDocumentInit(clonePdfBytes(documentData))).promise;

        try {
          const nextPages: AnswerPagePayload[] = [];

          for (const pageNumber of [...selectedPages].sort((a, b) => a - b)) {
            const page = await pdfDocument.getPage(pageNumber);
            const baseViewport = page.getViewport({ scale: 1 });
            const scale = Math.max(1.8, 1440 / Math.max(1, baseViewport.width));
            const viewport = page.getViewport({ scale });
            const renderCanvas = document.createElement("canvas");
            renderCanvas.width = Math.round(viewport.width);
            renderCanvas.height = Math.round(viewport.height);
            const context = renderCanvas.getContext("2d", { alpha: false });

            if (!context) {
              continue;
            }

            await page.render({ canvasContext: context, viewport }).promise;

            const pageImageDataUrl = canvasToCompressedDataUrl(renderCanvas, {
              maxWidth: 1280,
              mimeType: "image/jpeg",
              quality: 0.9,
            });
            const analysisImageDataUrl = canvasToCompressedDataUrl(renderCanvas, {
              maxWidth: 640,
              mimeType: "image/jpeg",
              quality: 0.72,
            });

            if (!pageImageDataUrl) {
              continue;
            }

            nextPages.push({
              id: `answer-${pageNumber}`,
              pageNumber,
              pageImageDataUrl,
              analysisImageDataUrl: analysisImageDataUrl || pageImageDataUrl,
              extractedTextSnippet: textSnippets[pageNumber] ?? "",
              answerAnchors: answerAnchorsByPage[pageNumber] ?? [],
            });
          }

          if (!cancelled) {
            onPagesChange(nextPages);
          }
        } finally {
          void pdfDocument.destroy();
        }
      })().catch(() => {
        // Keep the quick selection when high-resolution regeneration fails.
      });
    });

    return () => {
      cancelled = true;
    };
  }, [answerAnchorsByPage, documentData, onPagesChange, selectedPages, selectionMode, textSnippets]);

  const documentSource = useMemo(() => {
    if (!documentData) {
      return null;
    }

    return { data: clonePdfBytes(documentData) };
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

  function buildQuickRegions(pageNumbers: number[]) {
    return [...pageNumbers]
      .sort((a, b) => a - b)
      .flatMap((pageNumber) => {
        const canvas = canvasRefs.current[pageNumber];
        const regionSlices = questionRegionsByPage[pageNumber] ?? [];

        return regionSlices.flatMap((region, regionIndex) => {
          const snapshotDataUrl = canvas
            ? cropCanvasToCompressedDataUrl(canvas, region.bounds, {
                maxWidth: 420,
                mimeType: "image/jpeg",
                quality: 0.76,
              })
            : PLACEHOLDER_IMAGE_DATA_URL;

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
              analysisDataUrl: snapshotDataUrl,
              extractedTextSnippet: region.textSnippet || textSnippets[pageNumber] || "",
              questionNumberHint: region.questionNumber,
            } satisfies SelectedQuestionRegionPayload,
          ];
        });
      })
      .map((region, index) => ({
        ...region,
        displayOrder: index + 1,
      }));
  }

  function buildQuickPages(pageNumbers: number[]) {
    return [...pageNumbers]
      .sort((a, b) => a - b)
      .flatMap((pageNumber) => {
        const canvas = canvasRefs.current[pageNumber];
        const pageImageDataUrl = canvas
          ? canvasToCompressedDataUrl(canvas, {
              maxWidth: 380,
              mimeType: "image/jpeg",
              quality: 0.76,
            })
          : PLACEHOLDER_IMAGE_DATA_URL;

        if (!pageImageDataUrl) {
          return [];
        }

        return [
          {
            id: `answer-${pageNumber}`,
            pageNumber,
            pageImageDataUrl,
            analysisImageDataUrl: pageImageDataUrl,
            extractedTextSnippet: textSnippets[pageNumber] ?? "",
            answerAnchors: answerAnchorsByPage[pageNumber] ?? [],
          } satisfies AnswerPagePayload,
        ];
      });
  }

  function emitQuickSelection(pageNumbers: number[]) {
    if (selectionMode === "region" && onRegionsChange) {
      onRegionsChange(pageNumbers.length > 0 ? buildQuickRegions(pageNumbers) : []);
      return;
    }

    if (selectionMode === "page" && onPagesChange) {
      onPagesChange(pageNumbers.length > 0 ? buildQuickPages(pageNumbers) : []);
    }
  }

  function togglePage(pageNumber: number) {
    const current = selectedPagesRef.current;
    const nextPages = current.includes(pageNumber)
      ? current.filter((value) => value !== pageNumber)
      : [...current, pageNumber].sort((a, b) => a - b);

    selectedPagesRef.current = nextPages;
    setSelectedPages(nextPages);
    emitQuickSelection(nextPages);
  }

  function selectAllPages() {
    const nextPages = Array.from({ length: numPages }, (_, index) => index + 1);
    selectedPagesRef.current = nextPages;
    setSelectedPages(nextPages);
    emitQuickSelection(nextPages);
  }

  function clearSelection() {
    selectedPagesRef.current = [];
    setSelectedPages([]);
    emitQuickSelection([]);
  }

  function registerCanvas(pageNumber: number) {
    const host = pageHostRefs.current[pageNumber];
    const canvas = host?.querySelector("canvas") ?? null;

    if (!(canvas instanceof HTMLCanvasElement)) {
      return;
    }

    canvasRefs.current[pageNumber] = canvas;

    if (selectedPagesRef.current.includes(pageNumber)) {
      setSelectedPages([...selectedPagesRef.current]);
      emitQuickSelection(selectedPagesRef.current);
    }
  }

  function getPageStatusLabel(pageNumber: number) {
    const status = getSegmentStatus(pageNumber);

    if (status === "loading") {
      return "분리 중";
    }

    if (status === "ready") {
      return selectionMode === "region" ? "문제" : "답안";
    }

    if (status === "error") {
      return "재시도";
    }

    return "선택";
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
        <div className="empty">PDF를 업로드하면 여기에서 페이지를 고를 수 있습니다.</div>
      ) : loadError ? (
        <div className="empty">{loadError}</div>
      ) : (
        <>
          <div className="selector-toolbar">
            <div className="button-row">
              <span className="status ok">
                {selectionMode === "region"
                  ? `현재 선택한 문제 문항: ${selectedQuestionCount}개`
                  : `현재 선택한 답안 페이지: ${selectedPages.length}개`}
              </span>
              <span className="subtle">
                {selectionMode === "region"
                  ? "문제 페이지를 누르면 해당 페이지 안 문항을 자동으로 분리합니다."
                  : "정답과 해설이 있는 페이지를 골라 주세요."}
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
            options={PDF_DOCUMENT_OPTIONS}
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
                      <span className={`status ${isSelectedPage ? "ok" : "warn"}`}>{getPageStatusLabel(pageNumber)}</span>
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
                        {textSnippets[pageNumber] ? textSnippets[pageNumber] : "텍스트가 적은 스캔 PDF입니다. 미리보기를 보고 선택해 주세요."}
                      </span>
                      {selectionMode === "region" ? (
                        <span className="subtle" style={{ display: "block", marginTop: 8 }}>
                          감지 문항 {detectedQuestionCount > 0 ? detectedQuestionCount : "분리 대기 중"}
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
