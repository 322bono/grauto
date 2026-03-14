"use client";

import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";

const PRINT_NOTE_STYLES = `
  :root {
    color-scheme: light;
  }

  * {
    box-sizing: border-box;
  }

  body {
    margin: 0;
    padding: 24px;
    background: #f4f4f2;
    color: #171717;
    font-family: "Noto Sans KR", Arial, sans-serif;
  }

  .print-note-render-root {
    display: grid;
    gap: 18px;
  }

  .print-note-page {
    display: grid;
    gap: 18px;
    padding: 28px;
    border-radius: 24px;
    background: #ffffff;
    border: 1px solid #d8d8d3;
    box-shadow: 0 10px 32px rgba(0, 0, 0, 0.08);
    page-break-after: always;
    break-after: page;
  }

  .print-note-page:last-child {
    page-break-after: auto;
    break-after: auto;
  }

  .print-note-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }

  .print-note-title {
    margin: 0;
    font-size: 28px;
    font-weight: 800;
    letter-spacing: -0.03em;
    color: #141414;
  }

  .print-note-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-end;
  }

  .print-note-pill {
    display: inline-flex;
    align-items: center;
    min-height: 34px;
    padding: 0 12px;
    border-radius: 999px;
    border: 1px solid #d6d6d1;
    background: #f5f5f1;
    color: #373737;
    font-size: 13px;
    font-weight: 700;
  }

  .print-note-pill.danger {
    color: #b43232;
    background: #fff1f0;
    border-color: #efc1bc;
  }

  .print-note-pill.success {
    color: #1f7b4d;
    background: #effaf3;
    border-color: #bfe3c9;
  }

  .print-note-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(280px, 0.85fr);
    gap: 18px;
    align-items: start;
  }

  .print-note-panel {
    display: grid;
    gap: 12px;
    padding: 18px;
    border-radius: 18px;
    border: 1px solid #deded8;
    background: #fcfcfa;
  }

  .print-note-panel.wide {
    grid-column: 1 / -1;
  }

  .print-note-panel strong {
    font-size: 15px;
    color: #202020;
  }

  .print-note-image {
    width: 100%;
    border-radius: 14px;
    border: 1px solid #dadad5;
    background: #ffffff;
    overflow: hidden;
  }

  .print-note-image img {
    display: block;
    width: 100%;
    height: auto;
  }

  .print-note-facts {
    display: grid;
    gap: 10px;
  }

  .print-note-fact {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-bottom: 10px;
    border-bottom: 1px dashed #d9d9d2;
  }

  .print-note-fact:last-child {
    padding-bottom: 0;
    border-bottom: none;
  }

  .print-note-fact span {
    color: #666;
    font-size: 14px;
  }

  .print-note-fact strong {
    text-align: right;
    color: #151515;
    font-size: 15px;
  }

  .print-note-copy {
    margin: 0;
    color: #2d2d2d;
    line-height: 1.7;
    font-size: 14px;
    white-space: pre-wrap;
  }

  .print-step-list {
    display: grid;
    gap: 10px;
  }

  .print-step-card {
    display: grid;
    grid-template-columns: 30px 1fr;
    gap: 10px;
    padding: 12px 14px;
    border-radius: 16px;
    border: 1px solid #dfdfd8;
    background: #ffffff;
  }

  .print-step-card.correct {
    border-color: #bfe3c9;
    background: #f2fbf5;
  }

  .print-step-card.incorrect {
    border-color: #efc1bc;
    background: #fff3f2;
  }

  .print-step-badge {
    display: inline-grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 999px;
    font-size: 13px;
    font-weight: 800;
    color: #fff;
  }

  .print-step-badge.correct {
    background: #2f9e63;
  }

  .print-step-badge.incorrect {
    background: #d94841;
  }

  .print-step-copy {
    display: grid;
    gap: 6px;
  }

  .print-step-copy strong {
    font-size: 14px;
  }

  .print-step-copy p {
    margin: 0;
    color: #555;
    line-height: 1.6;
    font-size: 13px;
  }

  @media print {
    body {
      background: #ffffff;
      padding: 0;
    }

    .print-note-page {
      box-shadow: none;
      border-radius: 0;
      border: none;
      margin: 0;
    }
  }
`;

function waitForImages(container: HTMLElement) {
  const images = Array.from(container.querySelectorAll("img"));

  return Promise.all(
    images.map(
      (image) =>
        new Promise<void>((resolve) => {
          if (image.complete && image.naturalWidth > 0) {
            resolve();
            return;
          }

          const cleanup = () => {
            image.removeEventListener("load", handleDone);
            image.removeEventListener("error", handleDone);
          };

          const handleDone = () => {
            cleanup();
            resolve();
          };

          image.addEventListener("load", handleDone, { once: true });
          image.addEventListener("error", handleDone, { once: true });
        })
    )
  );
}

function getNoteCards(element: HTMLElement) {
  const dedicatedCards = Array.from(element.querySelectorAll<HTMLElement>("[data-print-note-card='true']"));

  if (dedicatedCards.length > 0) {
    return dedicatedCards;
  }

  return Array.from(element.querySelectorAll<HTMLElement>("[data-note-card='true']"));
}

export async function exportWrongAnswerPdf(element: HTMLElement, title: string) {
  const cards = getNoteCards(element);

  if (cards.length === 0) {
    return;
  }

  await waitForImages(element);

  const pdf = new jsPDF({
    orientation: "portrait",
    unit: "pt",
    format: "a4",
  });

  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 26;

  for (const [index, card] of cards.entries()) {
    const canvas = await html2canvas(card, {
      backgroundColor: "#ffffff",
      scale: 2,
      useCORS: true,
      windowWidth: 1240,
      scrollX: 0,
      scrollY: 0,
    });

    const image = canvas.toDataURL("image/png");
    const ratio = Math.min((pageWidth - margin * 2) / canvas.width, (pageHeight - margin * 2) / canvas.height);
    const width = canvas.width * ratio;
    const height = canvas.height * ratio;

    if (index > 0) {
      pdf.addPage();
    }

    pdf.addImage(image, "PNG", margin, margin, width, height, undefined, "FAST");
  }

  pdf.save(`${title || "오답노트"}.pdf`);
}

export async function printWrongAnswerNote(element: HTMLElement, title: string) {
  const cards = getNoteCards(element);

  if (cards.length === 0) {
    return;
  }

  const printWindow = window.open("", "_blank", "width=1100,height=900");

  if (!printWindow) {
    throw new Error("인쇄 창을 열지 못했습니다. 팝업 차단을 해제한 뒤 다시 시도해 주세요.");
  }

  await waitForImages(element);

  const markup = cards.map((card) => card.outerHTML).join("");

  printWindow.document.open();
  printWindow.document.write(`
    <!doctype html>
    <html lang="ko">
      <head>
        <meta charset="utf-8" />
        <title>${title || "오답노트"}</title>
        <style>${PRINT_NOTE_STYLES}</style>
      </head>
      <body>
        <div class="print-note-render-root">${markup}</div>
      </body>
    </html>
  `);
  printWindow.document.close();

  await new Promise<void>((resolve) => {
    const complete = () => resolve();

    if (printWindow.document.readyState === "complete") {
      resolve();
      return;
    }

    printWindow.addEventListener("load", complete, { once: true });
  });

  const popupRoot = printWindow.document.body;

  if (popupRoot) {
    await waitForImages(popupRoot as unknown as HTMLElement);
  }

  printWindow.focus();
  printWindow.print();
}
