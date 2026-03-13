"use client";

import { useEffect, useState } from "react";
import type { ExamMetadata } from "@/lib/types";

const DEFAULT_SUBJECTS = ["수학", "영어", "국어", "과학", "사회", "한국사"];
const STORAGE_KEY = "auto-grader-subjects";

interface ExamMetadataFormProps {
  metadata: ExamMetadata;
  onChange: (metadata: ExamMetadata) => void;
}

export function ExamMetadataForm({ metadata, onChange }: ExamMetadataFormProps) {
  const [subjects, setSubjects] = useState<string[]>(DEFAULT_SUBJECTS);
  const [customSubject, setCustomSubject] = useState("");

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);

    if (!stored) {
      return;
    }

    try {
      const parsed = JSON.parse(stored);

      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        setSubjects(parsed);
      }
    } catch {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  function addSubject() {
    const nextSubject = customSubject.trim();

    if (!nextSubject || subjects.includes(nextSubject)) {
      return;
    }

    const nextSubjects = [...subjects, nextSubject];
    setSubjects(nextSubjects);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextSubjects));
    onChange({
      ...metadata,
      subject: nextSubject
    });
    setCustomSubject("");
  }

  return (
    <div className="card pad stack">
      <div className="selector-head">
        <div>
          <h2 className="section-title">시험 메타데이터</h2>
          <p className="subtle">과목, 시험명, 난이도, 풀이 시간 등을 함께 저장해 이후 복습 기록과 연결합니다.</p>
        </div>
      </div>

      <div className="meta-grid">
        <div className="field">
          <label htmlFor="subject">과목</label>
          <select id="subject" className="select" value={metadata.subject} onChange={(event) => onChange({ ...metadata, subject: event.target.value })}>
            {subjects.map((subject) => (
              <option key={subject} value={subject}>
                {subject}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="exam-name">시험지 이름</label>
          <input
            id="exam-name"
            className="input"
            value={metadata.examName}
            placeholder="예: 3월 고1 수학 모의고사"
            onChange={(event) => onChange({ ...metadata, examName: event.target.value })}
          />
        </div>

        <div className="field">
          <label htmlFor="difficulty">체감 난이도</label>
          <select
            id="difficulty"
            className="select"
            value={metadata.difficulty}
            onChange={(event) => onChange({ ...metadata, difficulty: event.target.value })}
          >
            <option value="쉬움">쉬움</option>
            <option value="보통">보통</option>
            <option value="어려움">어려움</option>
            <option value="매우 어려움">매우 어려움</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="duration">풀이 시간 (분)</label>
          <input
            id="duration"
            className="input"
            type="number"
            min={0}
            value={metadata.durationMinutes ?? ""}
            placeholder="선택 입력"
            onChange={(event) =>
              onChange({
                ...metadata,
                durationMinutes: event.target.value ? Number(event.target.value) : null
              })
            }
          />
        </div>

        <div className="field">
          <label htmlFor="taken-at">푼 날짜</label>
          <input id="taken-at" className="input" type="date" value={metadata.takenAt} onChange={(event) => onChange({ ...metadata, takenAt: event.target.value })} />
        </div>
      </div>

      <div className="field">
        <label htmlFor="memo">메모</label>
        <textarea
          id="memo"
          className="textarea"
          placeholder="컨디션, 실수 유형, 다음 복습 포인트를 적어 두세요."
          value={metadata.memo ?? ""}
          onChange={(event) => onChange({ ...metadata, memo: event.target.value })}
        />
      </div>

      <div className="field">
        <label htmlFor="custom-subject">과목 직접 추가</label>
        <div className="button-row">
          <input
            id="custom-subject"
            className="input"
            value={customSubject}
            placeholder="예: 물리학 I"
            onChange={(event) => setCustomSubject(event.target.value)}
          />
          <button type="button" className="cta ghost" onClick={addSubject}>
            과목 저장
          </button>
        </div>
      </div>
    </div>
  );
}
