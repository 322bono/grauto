# Vercel 배포 가이드

이 프로젝트는 Next.js 서버 라우트를 사용합니다.

- `app/api/grade/route.ts`
- `app/api/cloud-files/sync/route.ts`
- `app/api/cloud-files/detail/route.ts`
- `app/api/cloud-files/delete/route.ts`

따라서 정적 파일만 올리는 Hosting보다 Vercel 같은 서버 지원 배포가 잘 맞습니다.

## 1. Vercel에 올리기

### 방법 A. 가장 쉬운 방법

1. GitHub에 이 프로젝트를 올립니다.
2. Vercel 대시보드에서 `Add New Project`
3. GitHub 저장소 선택
4. Framework Preset이 `Next.js`로 잡히는지 확인
5. Deploy

Vercel은 Next.js를 자동 인식하므로 보통 추가 설정이 필요 없습니다.

### 방법 B. CLI로 배포

```bash
npm install -g vercel
vercel
```

첫 배포 뒤 운영 배포는:

```bash
vercel --prod
```

## 2. Vercel 환경 변수

Vercel 대시보드의 `Settings > Environment Variables`에 아래 값을 넣습니다.

### 서버 비밀값

아래 값들은 브라우저로 노출되면 안 됩니다.

```env
OPENAI_API_KEY=...
OPENAI_VISION_MODEL=gpt-4.1
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
```

### 공개 가능한 Firebase 웹 설정값

아래 값들은 웹 앱 설정값이라 클라이언트에 포함되어도 괜찮습니다.

```env
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...
```

중요:

- `OPENAI_API_KEY`를 `NEXT_PUBLIC_OPENAI_API_KEY`로 만들면 안 됩니다.
- 현재 코드는 서버에서만 `process.env.OPENAI_API_KEY`를 읽습니다.

Vercel 공식 문서:
- [Environment Variables](https://vercel.com/docs/environment-variables)
- [vercel env CLI](https://vercel.com/docs/cli/env)

## 3. Firebase Google 로그인 설정

배포 후 Google 로그인이 되려면 Firebase 콘솔에서 Vercel 도메인을 허용해야 합니다.

1. Firebase Console
2. `Authentication`
3. `Settings`
4. `Authorized domains`
5. 아래 도메인 추가

예시:

- `your-project.vercel.app`
- 실제 연결한 커스텀 도메인

Firebase 공식 문서:
- [Google sign-in on web](https://firebase.google.com/docs/auth/web/google-signin)

## 4. Cloudinary 준비

Cloudinary 콘솔에서 아래 값 확인 후 Vercel 환경 변수에 넣습니다.

- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`

이 앱은 브라우저에서 Cloudinary로 직접 업로드하지 않고, 서버 라우트를 거쳐 업로드합니다.

## 5. 배포 전 확인

로컬에서 먼저 확인:

```bash
npm run typecheck
npm run build
```

이 프로젝트는 현재 두 명령 모두 통과합니다.

## 6. 배포 후 체크리스트

배포가 끝나면 아래를 순서대로 확인합니다.

1. 메인 페이지 접속
2. Google 로그인 동작
3. PDF 업로드
4. `/api/grade` 채점 실행
5. 클라우드 기록 저장
6. `/records`에서 기록 다시 열기

## 7. 자주 하는 실수

- `OPENAI_API_KEY`를 `NEXT_PUBLIC_`로 넣음
- Firebase `Authorized domains`에 Vercel 도메인을 안 넣음
- Vercel 환경 변수를 넣고 재배포 안 함
- Cloudinary 비밀값 누락
