# Firebase / Cloudinary 설정

이 프로젝트는 아래 서비스를 함께 사용합니다.

- Firebase Authentication: Google 로그인
- Cloud Firestore: 채점 기록 메타데이터 저장
- Cloudinary: 문제 PDF, 답지 PDF, 상세 결과 JSON 저장

## 1. Firebase 콘솔 설정

### Authentication

1. Firebase 콘솔에서 `Authentication`으로 이동합니다.
2. `Sign-in method`에서 `Google`을 활성화합니다.
3. 배포 도메인을 쓸 예정이면 `Authorized domains`에 추가합니다.

### Firestore

1. `Firestore Database`를 생성합니다.
2. Native mode를 선택합니다.
3. 원하는 리전을 고릅니다.

## 2. Firestore 규칙 배포

프로젝트 폴더에서:

```bash
npm install -g firebase-tools
firebase login
firebase use justdance2-82ec4
firebase deploy --only firestore:rules
```

사용 파일:

- `firestore.rules`
- `firebase.json`

## 3. Cloudinary 설정

1. [Cloudinary Console](https://console.cloudinary.com/)에서 제품 환경을 생성합니다.
2. Dashboard에서 아래 값을 확인합니다.
   - `Cloud name`
   - `API Key`
   - `API Secret`
3. `.env` 또는 Vercel 환경 변수에 추가합니다.

```env
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
```

브라우저에서 Cloudinary로 직접 업로드하지 않고, Next.js 서버 라우트를 통해 업로드합니다. 그래서 `API Secret`은 클라이언트로 노출되지 않습니다.

## 4. 로컬 개발 환경 변수

```env
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash
NEXT_PUBLIC_FIREBASE_API_KEY=your_firebase_web_api_key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-project-id
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
NEXT_PUBLIC_FIREBASE_APP_ID=your_app_id
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
```

## 5. 현재 동작 범위

- 로그인 후 채점하면
  - PDF 파일은 Cloudinary에 업로드
  - 채점 기록 메타데이터는 Firestore에 저장
  - 상세 결과 JSON도 Cloudinary에 저장
- 비로그인 상태에서는 브라우저 로컬 기록만 저장
- 예전 로컬 기록은 자동으로 클라우드에 올라가지 않음

## 6. 배포 메모

- 현재는 Vercel 배포 기준이 가장 단순합니다.
- Vercel 배포 시 필요한 핵심 비밀값은 아래입니다.
  - `GEMINI_API_KEY`
  - `CLOUDINARY_CLOUD_NAME`
  - `CLOUDINARY_API_KEY`
  - `CLOUDINARY_API_SECRET`
