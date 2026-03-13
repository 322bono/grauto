# Firebase / Cloudinary 설정

이 프로젝트는 역할을 나눠서 씁니다.

- Firebase Authentication: Google 로그인
- Cloud Firestore: 채점 기록 메타데이터
- Cloudinary: 문제 PDF, 답지 PDF, 상세 결과 JSON

## 1. Firebase 콘솔 설정

### Authentication

1. Firebase 콘솔에서 `Authentication`으로 이동
2. `Sign-in method`에서 `Google` 활성화
3. 배포 도메인을 쓸 예정이면 `Authorized domains`에 추가

### Firestore

1. `Firestore Database` 생성
2. Native mode 선택
3. 원하는 리전 선택

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

1. [Cloudinary Console](https://console.cloudinary.com/)에서 제품 환경 생성
2. Dashboard에서 아래 값 확인
   - `Cloud name`
   - `API Key`
   - `API Secret`
3. `.env`에 추가

```env
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
```

이 앱은 브라우저에서 Cloudinary로 직접 업로드하지 않고, Next.js 서버 라우트를 통해 업로드합니다. 그래서 `API Secret`은 클라이언트로 노출되지 않습니다.

## 4. 로컬 개발용 환경 변수

```env
OPENAI_API_KEY=your_openai_key
OPENAI_VISION_MODEL=gpt-4.1
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
  - 상세 결과 JSON은 Cloudinary에 저장
- 비로그인 상태에서는 브라우저 로컬 기록만 저장
- 예전 로컬 기록은 자동으로 클라우드에 소급 업로드되지 않음

## 6. 배포 메모

- Next.js 서버 라우트를 사용하므로 정적 호스팅만으로는 부족합니다.
- Firebase를 계속 쓸 경우 `App Hosting`이 자연스럽고, 다른 Node 지원 호스팅도 가능합니다.
- 배포 환경에도 아래 비밀값이 필요합니다.
  - `OPENAI_API_KEY`
  - `CLOUDINARY_CLOUD_NAME`
  - `CLOUDINARY_API_KEY`
  - `CLOUDINARY_API_SECRET`
