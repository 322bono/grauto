"use client";

import type { AuthUserProfile, CloudExamRecord } from "@/lib/types";

interface CloudPanelProps {
  authUser: AuthUserProfile | null;
  cloudRecords: CloudExamRecord[];
  isSigningIn: boolean;
  isSyncing: boolean;
  syncMessage: string;
  onSignIn: () => Promise<void>;
  onSignOut: () => Promise<void>;
}

export function CloudPanel({
  authUser,
  cloudRecords,
  isSigningIn,
  isSyncing,
  syncMessage,
  onSignIn,
  onSignOut
}: CloudPanelProps) {
  return (
    <div className="card pad stack">
      <div className="selector-head">
        <div>
          <h2 className="section-title">Google 로그인 / 클라우드 기록</h2>
          <p className="subtle">로그인하면 채점한 PDF와 상세 결과가 클라우드에 동기화됩니다.</p>
        </div>
        {isSyncing ? <span className="status warn">동기화 중</span> : authUser ? <span className="status ok">로그인됨</span> : null}
      </div>

      {authUser ? (
        <div className="auth-user">
          {authUser.photoURL ? (
            <img alt="프로필" className="avatar" src={authUser.photoURL} />
          ) : (
            <div className="avatar fallback">{authUser.displayName.slice(0, 1)}</div>
          )}
          <div className="stack" style={{ gap: 4 }}>
            <strong>{authUser.displayName}</strong>
            <span className="subtle">{authUser.email}</span>
          </div>
          <button type="button" className="cta ghost" onClick={onSignOut}>
            로그아웃
          </button>
        </div>
      ) : (
        <div className="empty">
          로그인하면 지금까지 채점한 PDF와 결과 리포트를 다른 기기에서도 다시 볼 수 있습니다.
          <div className="button-row" style={{ marginTop: 12 }}>
            <button type="button" className="cta secondary" onClick={onSignIn} disabled={isSigningIn}>
              {isSigningIn ? "로그인 중..." : "Google로 로그인"}
            </button>
          </div>
        </div>
      )}

      {syncMessage ? <div className="detail-row">{syncMessage}</div> : null}

      <div className="stack">
        <strong>클라우드에 저장된 PDF</strong>
        {authUser ? (
          cloudRecords.length > 0 ? (
            cloudRecords.map((record) => (
              <div className="record-card" key={record.id}>
                <div className="record-head">
                  <strong>{record.metadata.examName || "이름 없는 시험"}</strong>
                  <span className="status ok">{Math.round(record.resultSummary.accuracyRate * 100)}%</span>
                </div>
                <div className="subtle">
                  {record.metadata.subject} · {new Date(record.createdAt).toLocaleDateString("ko-KR")} · 정답{" "}
                  {record.resultSummary.correctCount}/{record.resultSummary.totalQuestions}
                </div>
                <div className="button-row" style={{ marginTop: 12 }}>
                  <a className="cta ghost" href={record.questionPdfUrl} target="_blank" rel="noreferrer">
                    문제 PDF 열기
                  </a>
                  <a className="cta ghost" href={record.answerPdfUrl} target="_blank" rel="noreferrer">
                    답지 PDF 열기
                  </a>
                </div>
              </div>
            ))
          ) : (
            <div className="empty">아직 클라우드에 저장된 채점 PDF가 없습니다. 로그인 상태에서 채점하면 자동으로 올라갑니다.</div>
          )
        ) : (
          <div className="empty">로그인하면 여기에서 업로드한 문제 PDF와 답지 PDF를 다시 열 수 있습니다.</div>
        )}
      </div>
    </div>
  );
}
