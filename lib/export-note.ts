"use client";

import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";

export async function exportWrongAnswerPdf(element: HTMLElement, title: string) {
  const cards = Array.from(element.querySelectorAll<HTMLElement>("[data-note-card='true']"));

  if (cards.length === 0) {
    return;
  }

  const pdf = new jsPDF({
    orientation: "portrait",
    unit: "pt",
    format: "a4"
  });

  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 28;

  for (const [index, card] of cards.entries()) {
    const canvas = await html2canvas(card, {
      backgroundColor: "#ffffff",
      scale: 2,
      useCORS: true
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
