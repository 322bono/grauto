export type UploadMode = "single" | "split";

export type QuestionType = "multiple-choice" | "short-answer" | "essay";

export type WorkAuthenticity = "solved" | "guessed" | "blank" | "unclear";

export interface ExamMetadata {
  subject: string;
  examName: string;
  difficulty: string;
  durationMinutes: number | null;
  takenAt: string;
  customSubject?: string;
  memo?: string;
}

export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SelectedQuestionRegionPayload {
  id: string;
  pageNumber: number;
  displayOrder: number;
  bounds: NormalizedRect;
  snapshotDataUrl: string;
  pageImageDataUrl: string;
  extractedTextSnippet?: string;
}

export interface AnswerPagePayload {
  id: string;
  pageNumber: number;
  pageImageDataUrl: string;
  extractedTextSnippet?: string;
}

export interface GradeRequestPayload {
  uploadMode: UploadMode;
  metadata: ExamMetadata;
  questionSelections: SelectedQuestionRegionPayload[];
  answerPages: AnswerPagePayload[];
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface QuestionFeedback {
  mistakeReason: string;
  explanation: string;
  recommendedReview: string;
  conceptTags: string[];
}

export interface WorkEvidence {
  authenticity: WorkAuthenticity;
  rationale: string;
  extractedWork: string;
  detectedMarks: string[];
}

export interface QuestionDeepAnalysis {
  requestedAt: string;
  reasonSteps?: string[];
  answerSheetBasis?: string;
  oneLineSummary?: string;
  logicalGap?: string;
  conceptGap?: string;
  modelSolution?: string;
  studyTip?: string;
}

export interface QuestionResult {
  selectionId: string;
  questionNumber: number | null;
  detectedHeaderText: string;
  questionType: QuestionType;
  studentAnswer: string;
  correctAnswer: string;
  isCorrect: boolean;
  score: number;
  maxScore: number;
  confidence: number;
  reviewRequired: boolean;
  matchedAnswerPageNumber: number | null;
  matchedAnswerReason: string;
  answerRegion: BoundingBox | null;
  explanationRegion: BoundingBox | null;
  workEvidence: WorkEvidence;
  feedback: QuestionFeedback;
  deepAnalysis?: QuestionDeepAnalysis;
  overrideApplied?: boolean;
}

export interface GradeSummary {
  totalQuestions: number;
  correctCount: number;
  incorrectCount: number;
  reviewRequiredCount: number;
  accuracyRate: number;
  weakAreas: string[];
  encouragement: string;
}

export interface GradeResponsePayload {
  generatedAt: string;
  mode: "vision" | "fallback";
  summary: GradeSummary;
  questions: QuestionResult[];
}

export interface AnalyzeRequestPayload {
  metadata: ExamMetadata;
  question: QuestionResult;
  selection: SelectedQuestionRegionPayload;
  answerPage: AnswerPagePayload | null;
  explanationCropDataUrl?: string | null;
}

export interface AnalyzeResponsePayload {
  analysis: QuestionDeepAnalysis;
}

export interface StoredExamRecord {
  id: string;
  createdAt: string;
  uploadMode: UploadMode;
  metadata: ExamMetadata;
  questionFileName: string;
  answerFileName: string;
  questionSelections: SelectedQuestionRegionPayload[];
  answerPages: AnswerPagePayload[];
  result: GradeResponsePayload;
  cloudSync?: CloudSyncState;
}

export interface CloudSyncState {
  remoteId: string;
  syncedAt: string;
  questionPdfUrl: string;
  answerPdfUrl: string;
  detailJsonUrl?: string;
  detailStoragePath?: string;
}

export interface AuthUserProfile {
  uid: string;
  displayName: string;
  email: string;
  photoURL: string | null;
}

export interface CloudExamRecord {
  id: string;
  ownerUid: string;
  createdAt: string;
  updatedAt: string;
  uploadMode: UploadMode;
  metadata: ExamMetadata;
  questionFileName: string;
  answerFileName: string;
  previewImageDataUrl?: string;
  questionPdfUrl: string;
  questionStoragePath: string;
  answerPdfUrl: string;
  answerStoragePath: string;
  detailJsonUrl?: string;
  detailStoragePath?: string;
  resultSummary: GradeSummary;
  resultMode: GradeResponsePayload["mode"];
}
